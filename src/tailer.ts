import fs from "node:fs/promises";
import path from "node:path";
import {
  MEMORY_HOST_EVENT_LOG_RELATIVE_PATH,
  type MemoryHostEvent,
  type MemoryHostPromotionAppliedEvent,
  type PluginLogger,
  resolveMemoryHostEventLogPath,
} from "../api.js";

export const CURSOR_RELATIVE_PATH = path.join("memory", ".dreams", ".dream-police.cursor");

type Cursor = {
  offset: number;
  lastTimestamp: string;
};

export type TailerHandler = (event: MemoryHostPromotionAppliedEvent) => Promise<void>;

export type TailerDeps = {
  readRange?: (absolutePath: string, start: number, end: number) => Promise<Buffer>;
  readFile?: (absolutePath: string) => Promise<string>;
  writeFile?: (absolutePath: string, content: string) => Promise<void>;
  stat?: (absolutePath: string) => Promise<{ size: number }>;
  mkdir?: (absolutePath: string) => Promise<void>;
  fileExists?: (absolutePath: string) => Promise<boolean>;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type TailerParams = {
  workspaceDir: string;
  pollIntervalMs: number;
  pauseFile: string;
  logger: PluginLogger;
  handler: TailerHandler;
  deps?: TailerDeps;
};

function defaultFileExists(absolutePath: string): Promise<boolean> {
  return fs
    .access(absolutePath)
    .then(() => true)
    .catch(() => false);
}

async function defaultReadRange(
  absolutePath: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const handle = await fs.open(absolutePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const defaultDeps: Required<TailerDeps> = {
  readRange: defaultReadRange,
  readFile: (p) => fs.readFile(p, "utf8"),
  writeFile: (p, c) => fs.writeFile(p, c, "utf8"),
  stat: (p) => fs.stat(p).then((s) => ({ size: s.size })),
  mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
  fileExists: defaultFileExists,
  setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn: (handle) => clearTimeout(handle),
};

function resolveDeps(deps: TailerDeps | undefined): Required<TailerDeps> {
  return {
    readRange: deps?.readRange ?? defaultDeps.readRange,
    readFile: deps?.readFile ?? defaultDeps.readFile,
    writeFile: deps?.writeFile ?? defaultDeps.writeFile,
    stat: deps?.stat ?? defaultDeps.stat,
    mkdir: deps?.mkdir ?? defaultDeps.mkdir,
    fileExists: deps?.fileExists ?? defaultDeps.fileExists,
    setTimeoutFn: deps?.setTimeoutFn ?? defaultDeps.setTimeoutFn,
    clearTimeoutFn: deps?.clearTimeoutFn ?? defaultDeps.clearTimeoutFn,
  };
}

async function readCursor(cursorPath: string, deps: Required<TailerDeps>): Promise<Cursor> {
  const exists = await deps.fileExists(cursorPath);
  if (!exists) {
    return { offset: 0, lastTimestamp: "" };
  }
  try {
    const raw = await deps.readFile(cursorPath);
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    if (typeof parsed.offset !== "number" || parsed.offset < 0) {
      return { offset: 0, lastTimestamp: "" };
    }
    return {
      offset: parsed.offset,
      lastTimestamp: typeof parsed.lastTimestamp === "string" ? parsed.lastTimestamp : "",
    };
  } catch {
    return { offset: 0, lastTimestamp: "" };
  }
}

async function writeCursor(
  cursorPath: string,
  cursor: Cursor,
  deps: Required<TailerDeps>,
): Promise<void> {
  await deps.mkdir(path.dirname(cursorPath));
  await deps.writeFile(cursorPath, JSON.stringify(cursor, null, 2));
}

type ParsedChunk = {
  events: MemoryHostEvent[];
  consumedBytes: number;
};

/**
 * Parse a buffer of newline-delimited JSON events.
 * Only fully-terminated lines (ending in '\n') are consumed; a trailing
 * partial line is left for the next poll so we never advance the cursor past
 * bytes we didn't actually deliver.
 */
function parseChunk(buf: Buffer): ParsedChunk {
  const events: MemoryHostEvent[] = [];
  let consumedBytes = 0;
  let lineStart = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a /* '\n' */) {
      const lineEnd = i;
      const line = buf.toString("utf8", lineStart, lineEnd).trim();
      consumedBytes = i + 1;
      lineStart = i + 1;
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as MemoryHostEvent);
      } catch {
        // skip malformed line
      }
    }
  }
  return { events, consumedBytes };
}

function isPromotionApplied(event: MemoryHostEvent): event is MemoryHostPromotionAppliedEvent {
  return event.type === "memory.promotion.applied";
}

export class JournalTailer {
  private stopped = false;
  private running = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly params: TailerParams) {}

  private get deps(): Required<TailerDeps> {
    return resolveDeps(this.params.deps);
  }

  private get journalPath(): string {
    return resolveMemoryHostEventLogPath(this.params.workspaceDir);
  }

  private get cursorPath(): string {
    return path.resolve(this.params.workspaceDir, CURSOR_RELATIVE_PATH);
  }

  private get pauseFilePath(): string {
    return path.resolve(this.params.workspaceDir, this.params.pauseFile);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.scheduleNext(this.params.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timeoutHandle) {
      this.deps.clearTimeoutFn(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.inflight) {
      await this.inflight;
    }
  }

  async poll(): Promise<number> {
    if (this.stopped) {
      return 0;
    }
    const paused = await this.deps.fileExists(this.pauseFilePath);
    if (paused) {
      return 0;
    }
    const journalExists = await this.deps.fileExists(this.journalPath);
    if (!journalExists) {
      return 0;
    }
    const cursor = await readCursor(this.cursorPath, this.deps);
    const stats = await this.deps.stat(this.journalPath);
    let startOffset = cursor.offset;
    if (stats.size < startOffset) {
      startOffset = 0;
      this.params.logger.info(
        "dream-police: journal shrank; resetting cursor to 0 (likely truncation/rotation)",
      );
    }
    if (stats.size === startOffset) {
      return 0;
    }
    const buf = await this.deps.readRange(this.journalPath, startOffset, stats.size);
    const { events, consumedBytes } = parseChunk(buf);
    const promotions = events.filter(isPromotionApplied);
    let processed = 0;
    for (const event of promotions) {
      try {
        await this.params.handler(event);
        processed += 1;
      } catch (err) {
        this.params.logger.warn(
          `dream-police: handler threw for event timestamp=${event.timestamp}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const nextCursor: Cursor = {
      offset: startOffset + consumedBytes,
      lastTimestamp: promotions.at(-1)?.timestamp ?? cursor.lastTimestamp,
    };
    await writeCursor(this.cursorPath, nextCursor, this.deps);
    return processed;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timeoutHandle = this.deps.setTimeoutFn(() => {
      this.timeoutHandle = null;
      if (this.stopped) return;
      this.inflight = this.runOnce();
      void this.inflight.finally(() => {
        this.inflight = null;
        if (!this.stopped) {
          this.scheduleNext(this.params.pollIntervalMs);
        }
      });
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.poll();
    } catch (err) {
      this.params.logger.warn(
        `dream-police: tailer error ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const TAILER_DEFAULTS = {
  memoryEventLogRelativePath: MEMORY_HOST_EVENT_LOG_RELATIVE_PATH,
};
