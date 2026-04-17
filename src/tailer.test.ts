import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryHostPromotionAppliedEvent, PluginLogger } from "../api.js";
import { CURSOR_RELATIVE_PATH, JournalTailer } from "./tailer.js";

type FakeFs = {
  files: Map<string, string>;
  readRange(path: string, start: number, end: number): Promise<Buffer>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  mkdir(): Promise<void>;
  fileExists(path: string): Promise<boolean>;
};

function makeFakeFs(): FakeFs {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`not found: ${path}`);
      }
      return value;
    },
    async readRange(path, start, end) {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`not found: ${path}`);
      }
      return Buffer.from(value, "utf8").subarray(start, end);
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async stat(path) {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`not found: ${path}`);
      }
      return { size: Buffer.byteLength(value, "utf8") };
    },
    async mkdir() {},
    async fileExists(path) {
      return files.has(path);
    },
  };
}

const silentLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function promotionEvent(ts: string): MemoryHostPromotionAppliedEvent {
  return {
    type: "memory.promotion.applied",
    timestamp: ts,
    memoryPath: "memory/long-term.md",
    applied: 1,
    candidates: [{ key: "k1", path: "a.md", startLine: 1, endLine: 1, score: 0.9, recallCount: 1 }],
  };
}

function recallEvent(ts: string) {
  return { type: "memory.recall.recorded", timestamp: ts, query: "q", resultCount: 0, results: [] };
}

const WORKSPACE = "/ws";
const JOURNAL_PATH = "/ws/memory/.dreams/events.jsonl";
const CURSOR_PATH = `/ws/${CURSOR_RELATIVE_PATH}`;

describe("JournalTailer", () => {
  let fake: FakeFs;
  beforeEach(() => {
    fake = makeFakeFs();
  });

  it("delivers new promotion events and advances the cursor", async () => {
    const received: string[] = [];
    fake.files.set(
      JOURNAL_PATH,
      [
        JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")),
        JSON.stringify(recallEvent("2026-04-16T00:00:02Z")),
      ].join("\n") + "\n",
    );
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async (event) => {
        received.push(event.timestamp);
      },
      deps: fake,
    });
    const processed = await tailer.poll();
    expect(processed).toBe(1);
    expect(received).toEqual(["2026-04-16T00:00:01Z"]);
    const savedCursor = JSON.parse(fake.files.get(CURSOR_PATH) as string);
    expect(savedCursor.offset).toBe(
      Buffer.byteLength(fake.files.get(JOURNAL_PATH) as string, "utf8"),
    );
    expect(savedCursor.lastTimestamp).toBe("2026-04-16T00:00:01Z");
  });

  it("handles multibyte UTF-8 content without losing events", async () => {
    const eventWithEmoji: MemoryHostPromotionAppliedEvent = {
      ...promotionEvent("2026-04-16T00:00:01Z"),
      memoryPath: "memory/héllo-😺.md",
    };
    const journalContent =
      JSON.stringify(eventWithEmoji) +
      "\n" +
      JSON.stringify(promotionEvent("2026-04-16T00:00:02Z")) +
      "\n";
    fake.files.set(JOURNAL_PATH, journalContent);
    const received: string[] = [];
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async (event) => {
        received.push(event.timestamp);
      },
      deps: fake,
    });
    const processed = await tailer.poll();
    expect(processed).toBe(2);
    expect(received).toEqual(["2026-04-16T00:00:01Z", "2026-04-16T00:00:02Z"]);
    const savedCursor = JSON.parse(fake.files.get(CURSOR_PATH) as string);
    expect(savedCursor.offset).toBe(Buffer.byteLength(journalContent, "utf8"));
  });

  it("leaves a trailing partial line for the next poll", async () => {
    const firstLine = JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")) + "\n";
    const secondLineWithoutTerminator = JSON.stringify(promotionEvent("2026-04-16T00:00:02Z"));
    fake.files.set(JOURNAL_PATH, firstLine + secondLineWithoutTerminator);
    const received: string[] = [];
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async (event) => {
        received.push(event.timestamp);
      },
      deps: fake,
    });
    await tailer.poll();
    expect(received).toEqual(["2026-04-16T00:00:01Z"]);
    // finish the partial line and poll again
    fake.files.set(JOURNAL_PATH, firstLine + secondLineWithoutTerminator + "\n");
    await tailer.poll();
    expect(received).toEqual(["2026-04-16T00:00:01Z", "2026-04-16T00:00:02Z"]);
  });

  it("does not redeliver already-processed events", async () => {
    fake.files.set(JOURNAL_PATH, JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")) + "\n");
    const received: string[] = [];
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async (event) => {
        received.push(event.timestamp);
      },
      deps: fake,
    });
    await tailer.poll();
    await tailer.poll();
    expect(received).toHaveLength(1);
  });

  it("resets the cursor when the journal shrinks (truncation)", async () => {
    const bigEvent =
      JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")) +
      "\n" +
      JSON.stringify(promotionEvent("2026-04-16T00:00:02Z")) +
      "\n";
    fake.files.set(JOURNAL_PATH, bigEvent);
    const received: string[] = [];
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async (event) => {
        received.push(event.timestamp);
      },
      deps: fake,
    });
    await tailer.poll();
    expect(received).toHaveLength(2);
    received.length = 0;
    fake.files.set(JOURNAL_PATH, JSON.stringify(promotionEvent("2026-04-16T00:00:03Z")) + "\n");
    const processed = await tailer.poll();
    expect(processed).toBe(1);
    expect(received).toEqual(["2026-04-16T00:00:03Z"]);
  });

  it("stops polling when the pause file is present", async () => {
    fake.files.set(JOURNAL_PATH, JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")) + "\n");
    fake.files.set(`${WORKSPACE}/.dream-police.paused`, "");
    const received: string[] = [];
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async (event) => {
        received.push(event.timestamp);
      },
      deps: fake,
    });
    const processed = await tailer.poll();
    expect(processed).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("handler errors do not stop the tailer and the cursor still advances", async () => {
    fake.files.set(
      JOURNAL_PATH,
      [
        JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")),
        JSON.stringify(promotionEvent("2026-04-16T00:00:02Z")),
      ].join("\n") + "\n",
    );
    let calls = 0;
    const tailer = new JournalTailer({
      workspaceDir: WORKSPACE,
      pollIntervalMs: 1000,
      pauseFile: ".dream-police.paused",
      logger: silentLogger,
      handler: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }
      },
      deps: fake,
    });
    const processed = await tailer.poll();
    expect(calls).toBe(2);
    expect(processed).toBe(1);
  });

  it("start() schedules polls on the interval; stop() cancels and awaits in-flight work", async () => {
    vi.useFakeTimers();
    try {
      fake.files.set(JOURNAL_PATH, JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")) + "\n");
      const received: string[] = [];
      const tailer = new JournalTailer({
        workspaceDir: WORKSPACE,
        pollIntervalMs: 500,
        pauseFile: ".dream-police.paused",
        logger: silentLogger,
        handler: async (event) => {
          received.push(event.timestamp);
        },
        deps: fake,
      });
      await tailer.start();
      await vi.advanceTimersByTimeAsync(500);
      // drain microtasks
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual(["2026-04-16T00:00:01Z"]);
      // Second tick with no new events: no additional delivery.
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(1);
      await tailer.stop();
      // After stop, further ticks do nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent; calling twice does not schedule parallel loops", async () => {
    vi.useFakeTimers();
    try {
      fake.files.set(JOURNAL_PATH, JSON.stringify(promotionEvent("2026-04-16T00:00:01Z")) + "\n");
      const received: string[] = [];
      const tailer = new JournalTailer({
        workspaceDir: WORKSPACE,
        pollIntervalMs: 500,
        pauseFile: ".dream-police.paused",
        logger: silentLogger,
        handler: async (event) => {
          received.push(event.timestamp);
        },
        deps: fake,
      });
      await tailer.start();
      await tailer.start();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual(["2026-04-16T00:00:01Z"]);
      await tailer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
