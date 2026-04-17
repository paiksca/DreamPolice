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

export async function buildPromotionDiff(
  workspaceDir: string,
  event: MemoryHostPromotionAppliedEvent,
  deps: { readFile?: ReadFileFn } = {},
): Promise<PromotionDiff | null> {
  if (event.candidates.length === 0 || event.applied === 0) {
    return null;
  }
  const readFile = deps.readFile ?? defaultReadFile;
  const absMemoryPath = path.isAbsolute(event.memoryPath)
    ? event.memoryPath
    : path.resolve(workspaceDir, event.memoryPath);
  const content = await readFile(absMemoryPath);

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
