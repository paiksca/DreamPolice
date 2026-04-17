import fs from "node:fs/promises";
import path from "node:path";

export type HistoryOutcome =
  | "accepted"
  | "accepted-after-correction"
  | "flagged"
  | "skipped";

export type HistoryEntry = {
  timestamp: string;
  outcome: HistoryOutcome;
  memoryPath: string;
  candidateKeys: string[];
  rounds: number;
  confidence?: number;
  rationale?: string;
  note?: string;
};

export type HistoryDeps = {
  appendFile?: (absolutePath: string, content: string) => Promise<void>;
  mkdir?: (absolutePath: string) => Promise<void>;
};

const defaultAppend = (p: string, c: string): Promise<void> => fs.appendFile(p, c, "utf8");
const defaultMkdir = (p: string): Promise<void> =>
  fs.mkdir(p, { recursive: true }).then(() => undefined);

export function renderHistoryEntry(entry: HistoryEntry): string {
  const keys = entry.candidateKeys.length === 0 ? "(none)" : entry.candidateKeys.join(", ");
  const confidence = typeof entry.confidence === "number"
    ? ` confidence=${entry.confidence.toFixed(2)}`
    : "";
  const note = entry.note ? ` · ${entry.note}` : "";
  const rationale = entry.rationale ? `\n  rationale: ${entry.rationale}` : "";
  return [
    `- **${entry.timestamp}** [${entry.outcome}] ${entry.memoryPath} rounds=${entry.rounds}${confidence}${note}`,
    `  candidates: ${keys}${rationale}`,
    "",
  ].join("\n");
}

export async function appendHistoryEntry(params: {
  workspaceDir: string;
  historyFile: string;
  entry: HistoryEntry;
  deps?: HistoryDeps;
}): Promise<string> {
  const appendFile = params.deps?.appendFile ?? defaultAppend;
  const mkdir = params.deps?.mkdir ?? defaultMkdir;
  const absolutePath = path.isAbsolute(params.historyFile)
    ? params.historyFile
    : path.resolve(params.workspaceDir, params.historyFile);
  await mkdir(path.dirname(absolutePath));
  await appendFile(absolutePath, renderHistoryEntry(params.entry));
  return absolutePath;
}

export type HistoryReadDeps = {
  readFile?: (absolutePath: string) => Promise<string>;
  fileExists?: (absolutePath: string) => Promise<boolean>;
};

const defaultRead = (p: string): Promise<string> => fs.readFile(p, "utf8");
const defaultExists = (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

export async function readRecentHistory(params: {
  workspaceDir: string;
  historyFile: string;
  limit?: number;
  deps?: HistoryReadDeps;
}): Promise<string> {
  const read = params.deps?.readFile ?? defaultRead;
  const exists = params.deps?.fileExists ?? defaultExists;
  const absolutePath = path.isAbsolute(params.historyFile)
    ? params.historyFile
    : path.resolve(params.workspaceDir, params.historyFile);
  if (!(await exists(absolutePath))) return "";
  const raw = await read(absolutePath);
  if (!params.limit || params.limit <= 0) return raw;
  // Each entry is 3 lines (summary, candidates/rationale, blank). Group and
  // return the last `limit` entries.
  const blocks = raw.split(/\n(?=- \*\*)/);
  return blocks.slice(-params.limit).join("\n");
}
