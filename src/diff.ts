import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryHostPromotionAppliedEvent } from "../api.js";
import type { PromotionCandidateSlice, PromotionDiff } from "./types.js";

export type ReadFileFn = (absolutePath: string) => Promise<string>;

const defaultReadFile: ReadFileFn = (absolutePath) => fs.readFile(absolutePath, "utf8");

function sliceLines(content: string, startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return "";
  }
  const lines = content.split("\n");
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

function expandToBlock(
  candidates: MemoryHostPromotionAppliedEvent["candidates"],
): { startLine: number; endLine: number } | null {
  if (candidates.length === 0) {
    return null;
  }
  let startLine = candidates[0].startLine;
  let endLine = candidates[0].endLine;
  for (const candidate of candidates) {
    if (candidate.startLine < startLine) {
      startLine = candidate.startLine;
    }
    if (candidate.endLine > endLine) {
      endLine = candidate.endLine;
    }
  }
  return { startLine, endLine };
}

function resolveMemoryAbsolutePath(workspaceDir: string, memoryPath: string): string {
  return path.isAbsolute(memoryPath) ? memoryPath : path.resolve(workspaceDir, memoryPath);
}

export async function buildPromotionDiff(
  workspaceDir: string,
  event: MemoryHostPromotionAppliedEvent,
  deps: { readFile?: ReadFileFn } = {},
): Promise<PromotionDiff | null> {
  if (event.candidates.length === 0 || event.applied === 0) {
    return null;
  }
  const readFile = deps.readFile ?? defaultReadFile;
  const content = await readFile(resolveMemoryAbsolutePath(workspaceDir, event.memoryPath));

  const slices: PromotionCandidateSlice[] = event.candidates.map((candidate) => ({
    key: candidate.key,
    sourcePath: candidate.path,
    memoryPath: event.memoryPath,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    score: candidate.score,
    recallCount: candidate.recallCount,
    snippet: sliceLines(content, candidate.startLine, candidate.endLine),
  }));

  const blockRange = expandToBlock(event.candidates);
  const rawBlock = blockRange
    ? sliceLines(content, blockRange.startLine, blockRange.endLine)
    : slices.map((slice) => slice.snippet).join("\n");

  return {
    memoryPath: event.memoryPath,
    appliedAt: event.timestamp,
    candidates: slices,
    rawBlock,
  };
}

/**
 * Read up to `maxLines` of the memory file *preceding* the first candidate's
 * startLine, so the verifier has local context (document structure, nearby
 * definitions) without seeing the candidate block itself.
 * Returns "" when `maxLines` is 0 or there's nothing to show.
 */
export async function buildPriorContext(
  workspaceDir: string,
  diff: PromotionDiff,
  deps: { readFile?: ReadFileFn; maxLines?: number } = {},
): Promise<string> {
  const maxLines = Math.max(0, deps.maxLines ?? 0);
  if (maxLines === 0 || diff.candidates.length === 0) {
    return "";
  }
  const readFile = deps.readFile ?? defaultReadFile;
  const absolutePath = resolveMemoryAbsolutePath(workspaceDir, diff.memoryPath);
  let content: string;
  try {
    content = await readFile(absolutePath);
  } catch {
    return "";
  }
  const firstStartLine = diff.candidates.reduce(
    (acc, c) => Math.min(acc, c.startLine),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(firstStartLine) || firstStartLine <= 1) {
    return "";
  }
  const endLine = (firstStartLine as number) - 1;
  const startLine = Math.max(1, endLine - maxLines + 1);
  return sliceLines(content, startLine, endLine);
}
