import fs from "node:fs/promises";
import path from "node:path";
import type { PromotionDiff, VerifierCritique, VerifierIssue } from "./types.js";

export const REWRITE_CONFIDENCE_THRESHOLD = 0.6;
export const TEMP_FILE_SUFFIX = ".dream-police.tmp";

export type CorrectorDeps = {
  readFile?: (absolutePath: string) => Promise<string>;
  /**
   * Writes `content` to `absolutePath` with fsync semantics. Default uses
   * `fs.open` + `write` + `sync` + `close` so the rename step below can be a
   * true atomic replace even on power loss.
   */
  writeFile?: (absolutePath: string, content: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (absolutePath: string) => Promise<void>;
};

async function defaultWriteFileSync(absolutePath: string, content: string): Promise<void> {
  const handle = await fs.open(absolutePath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const defaultDeps: Required<CorrectorDeps> = {
  readFile: (p) => fs.readFile(p, "utf8"),
  writeFile: defaultWriteFileSync,
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) =>
    fs.unlink(p).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }),
};

type EditKind = "remove" | "rewrite" | "annotate";

type PendingEdit = {
  kind: EditKind;
  startLine: number;
  endLine: number;
  replacement: string[];
  claim: string;
};

type ActionableIssue = {
  issue: VerifierIssue;
  action: VerifierIssue["suggestedAction"];
};

function pickActionableIssues(critique: VerifierCritique): ActionableIssue[] {
  return critique.issues
    .filter((issue) => issue.severity === "warn" || issue.severity === "error")
    .map((issue) => {
      if (
        issue.suggestedAction.kind === "rewrite" &&
        critique.confidence < REWRITE_CONFIDENCE_THRESHOLD
      ) {
        return {
          issue,
          action: {
            kind: "annotate" as const,
            note: `downgraded from rewrite (confidence ${critique.confidence.toFixed(2)} < ${REWRITE_CONFIDENCE_THRESHOLD})`,
          },
        };
      }
      return { issue, action: issue.suggestedAction };
    });
}

function buildAnnotation(issue: VerifierIssue, note: string): string {
  const safeNote = note.replace(/-->/g, "--&gt;");
  const reason = issue.reason ? ` // ${issue.reason.replace(/-->/g, "--&gt;")}` : "";
  return `<!-- dream-police: ${safeNote} -->${reason}`;
}

function toPendingEdit(entry: ActionableIssue): PendingEdit | null {
  const { issue, action } = entry;
  const { startLine, endLine } = issue.location;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine > endLine) {
    return null;
  }
  switch (action.kind) {
    case "remove":
      return { kind: "remove", startLine, endLine, replacement: [], claim: issue.claim };
    case "rewrite":
      return {
        kind: "rewrite",
        startLine,
        endLine,
        replacement: action.replacement.split("\n"),
        claim: issue.claim,
      };
    case "annotate":
      return {
        kind: "annotate",
        startLine: endLine,
        endLine,
        replacement: [buildAnnotation(issue, action.note)],
        claim: issue.claim,
      };
    default:
      return null;
  }
}

function rangesOverlap(a: PendingEdit, b: PendingEdit): boolean {
  // Annotate is an insertion at `endLine` (0-width), so it only conflicts
  // if another edit writes the exact same anchor line.
  if (a.kind === "annotate" && b.kind !== "annotate") {
    return a.endLine >= b.startLine && a.endLine <= b.endLine;
  }
  if (b.kind === "annotate" && a.kind !== "annotate") {
    return b.endLine >= a.startLine && b.endLine <= a.endLine;
  }
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function dropOverlappingEdits(edits: PendingEdit[]): PendingEdit[] {
  const kept: PendingEdit[] = [];
  for (const edit of edits) {
    if (kept.some((prior) => rangesOverlap(prior, edit))) continue;
    kept.push(edit);
  }
  return kept;
}

function planEdits(actionable: ActionableIssue[]): PendingEdit[] {
  const candidates = actionable
    .map(toPendingEdit)
    .filter((edit): edit is PendingEdit => edit !== null);
  const unique = dropOverlappingEdits(candidates);
  // Apply bottom-up so earlier edits don't shift later line numbers.
  return unique.toSorted((a, b) => b.startLine - a.startLine);
}

function applyEdits(originalLines: string[], edits: PendingEdit[]): string[] {
  const lines = [...originalLines];
  for (const edit of edits) {
    const startIndex = Math.max(0, edit.startLine - 1);
    const endIndex = Math.min(lines.length, edit.endLine);
    if (startIndex > endIndex) {
      continue;
    }
    if (edit.kind === "annotate") {
      lines.splice(endIndex, 0, ...edit.replacement);
      continue;
    }
    lines.splice(startIndex, endIndex - startIndex, ...edit.replacement);
  }
  return lines;
}

export type CorrectionSummary = {
  appliedEditCount: number;
  affectedClaims: string[];
};

export async function applyCorrection(params: {
  workspaceDir: string;
  diff: PromotionDiff;
  critique: VerifierCritique;
  deps?: CorrectorDeps;
}): Promise<CorrectionSummary> {
  const readFile = params.deps?.readFile ?? defaultDeps.readFile;
  const writeFile = params.deps?.writeFile ?? defaultDeps.writeFile;
  const rename = params.deps?.rename ?? defaultDeps.rename;
  const unlink = params.deps?.unlink ?? defaultDeps.unlink;

  const actionable = pickActionableIssues(params.critique);
  if (actionable.length === 0) {
    return { appliedEditCount: 0, affectedClaims: [] };
  }

  const edits = planEdits(actionable);
  if (edits.length === 0) {
    return { appliedEditCount: 0, affectedClaims: [] };
  }

  const absoluteMemoryPath = path.isAbsolute(params.diff.memoryPath)
    ? params.diff.memoryPath
    : path.resolve(params.workspaceDir, params.diff.memoryPath);

  const original = await readFile(absoluteMemoryPath);
  const updatedLines = applyEdits(original.split("\n"), edits);
  const updatedContent = updatedLines.join("\n");

  const tempPath = `${absoluteMemoryPath}${TEMP_FILE_SUFFIX}`;
  try {
    await writeFile(tempPath, updatedContent);
    await rename(tempPath, absoluteMemoryPath);
  } catch (err) {
    // Best-effort cleanup — if rename failed we don't want to leave a stray tmp.
    await unlink(tempPath).catch(() => {});
    throw err;
  }

  return {
    appliedEditCount: edits.length,
    affectedClaims: edits.map((edit) => edit.claim),
  };
}
