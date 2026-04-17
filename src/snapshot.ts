import fs from "node:fs/promises";
import path from "node:path";

export type SnapshotDeps = {
  readFile?: (absolutePath: string) => Promise<string>;
  writeFile?: (absolutePath: string, content: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (absolutePath: string) => Promise<void>;
  readdir?: (absolutePath: string) => Promise<string[]>;
  mkdir?: (absolutePath: string) => Promise<void>;
  fileExists?: (absolutePath: string) => Promise<boolean>;
  stat?: (absolutePath: string) => Promise<{ mtimeMs: number }>;
};

const d: Required<SnapshotDeps> = {
  readFile: (p) => fs.readFile(p, "utf8"),
  writeFile: (p, c) => fs.writeFile(p, c, "utf8"),
  rename: (f, t) => fs.rename(f, t),
  unlink: (p) =>
    fs.unlink(p).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }),
  readdir: (p) =>
    fs.readdir(p).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }),
  mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
  fileExists: (p) =>
    fs
      .access(p)
      .then(() => true)
      .catch(() => false),
  stat: (p) => fs.stat(p).then((s) => ({ mtimeMs: s.mtimeMs })),
};

function resolveDeps(deps: SnapshotDeps | undefined): Required<SnapshotDeps> {
  return {
    readFile: deps?.readFile ?? d.readFile,
    writeFile: deps?.writeFile ?? d.writeFile,
    rename: deps?.rename ?? d.rename,
    unlink: deps?.unlink ?? d.unlink,
    readdir: deps?.readdir ?? d.readdir,
    mkdir: deps?.mkdir ?? d.mkdir,
    fileExists: deps?.fileExists ?? d.fileExists,
    stat: deps?.stat ?? d.stat,
  };
}

/**
 * Encode a memory path into a filename-safe slug that round-trips back to
 * the original path via `unslugifyMemoryPath`. We preserve dots (so file
 * extensions survive) and use the single-character `~` as our slash
 * replacement — slashes aren't allowed in filenames on most filesystems,
 * and `~` never appears in OpenClaw memory paths in practice.
 */
export function slugifyMemoryPath(memoryPath: string): string {
  return memoryPath.replace(/\//g, "~");
}

export function unslugifyMemoryPath(slug: string): string {
  return slug.replace(/~/g, "/");
}

export const SNAPSHOT_SEPARATOR = "__";

function snapshotFilename(memoryPath: string, timestamp: string): string {
  return `${slugifyMemoryPath(memoryPath)}${SNAPSHOT_SEPARATOR}${timestamp.replace(/[:.]/g, "-")}.snap`;
}

export function parseSnapshotFilename(filename: string): { memoryPath: string; timestamp: string } | null {
  if (!filename.endsWith(".snap")) return null;
  const base = filename.slice(0, -".snap".length);
  const sepIndex = base.lastIndexOf(SNAPSHOT_SEPARATOR);
  if (sepIndex <= 0) return null;
  const slug = base.slice(0, sepIndex);
  const timestamp = base.slice(sepIndex + SNAPSHOT_SEPARATOR.length);
  if (!slug || !timestamp) return null;
  return { memoryPath: unslugifyMemoryPath(slug), timestamp };
}

/**
 * Write a snapshot of `memoryFile` before the corrector mutates it. The
 * snapshot file name encodes both the memory path and the timestamp so
 * we can later locate the most-recent snapshot for a specific memory.
 */
export async function captureSnapshot(params: {
  workspaceDir: string;
  memoryPath: string;
  snapshotDir: string;
  now?: () => Date;
  deps?: SnapshotDeps;
}): Promise<string | null> {
  const deps = resolveDeps(params.deps);
  const now = params.now ?? (() => new Date());
  const absoluteMemory = path.isAbsolute(params.memoryPath)
    ? params.memoryPath
    : path.resolve(params.workspaceDir, params.memoryPath);
  if (!(await deps.fileExists(absoluteMemory))) return null;
  const absoluteSnapshotDir = path.isAbsolute(params.snapshotDir)
    ? params.snapshotDir
    : path.resolve(params.workspaceDir, params.snapshotDir);
  await deps.mkdir(absoluteSnapshotDir);
  const content = await deps.readFile(absoluteMemory);
  const timestamp = now().toISOString();
  const filename = snapshotFilename(params.memoryPath, timestamp);
  const snapshotPath = path.join(absoluteSnapshotDir, filename);
  const tempPath = `${snapshotPath}.tmp`;
  await deps.writeFile(tempPath, content);
  await deps.rename(tempPath, snapshotPath);
  return snapshotPath;
}

export async function listSnapshots(params: {
  workspaceDir: string;
  snapshotDir: string;
  memoryPath?: string;
  deps?: SnapshotDeps;
}): Promise<Array<{ filename: string; absolutePath: string; mtimeMs: number }>> {
  const deps = resolveDeps(params.deps);
  const absoluteSnapshotDir = path.isAbsolute(params.snapshotDir)
    ? params.snapshotDir
    : path.resolve(params.workspaceDir, params.snapshotDir);
  const names = await deps.readdir(absoluteSnapshotDir);
  const prefix = params.memoryPath
    ? slugifyMemoryPath(params.memoryPath) + SNAPSHOT_SEPARATOR
    : null;
  const filtered = names.filter((n) => n.endsWith(".snap") && (!prefix || n.startsWith(prefix)));
  const enriched = await Promise.all(
    filtered.map(async (filename) => {
      const absolutePath = path.join(absoluteSnapshotDir, filename);
      const { mtimeMs } = await deps.stat(absolutePath);
      return { filename, absolutePath, mtimeMs };
    }),
  );
  return enriched.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function pruneSnapshots(params: {
  workspaceDir: string;
  snapshotDir: string;
  keep: number;
  memoryPath?: string;
  deps?: SnapshotDeps;
}): Promise<number> {
  const deps = resolveDeps(params.deps);
  const entries = await listSnapshots({
    workspaceDir: params.workspaceDir,
    snapshotDir: params.snapshotDir,
    ...(params.memoryPath ? { memoryPath: params.memoryPath } : {}),
    deps: params.deps,
  });
  const doomed = entries.slice(Math.max(0, params.keep));
  for (const e of doomed) {
    await deps.unlink(e.absolutePath);
  }
  return doomed.length;
}

export async function restoreSnapshot(params: {
  workspaceDir: string;
  snapshotAbsolutePath: string;
  memoryPath: string;
  deps?: SnapshotDeps;
}): Promise<void> {
  const deps = resolveDeps(params.deps);
  const absoluteMemory = path.isAbsolute(params.memoryPath)
    ? params.memoryPath
    : path.resolve(params.workspaceDir, params.memoryPath);
  const content = await deps.readFile(params.snapshotAbsolutePath);
  const tempPath = `${absoluteMemory}.dream-police.tmp`;
  await deps.writeFile(tempPath, content);
  await deps.rename(tempPath, absoluteMemory);
}
