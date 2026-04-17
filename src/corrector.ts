import fs from "node:fs/promises";
import path from "node:path";
import type { PromotionDiff, VerifierCritique, VerifierIssue } from "./types.js";

const REWRITE_CONFIDENCE_THRESHOLD = 0.6;

export type CorrectorDeps = {
  readFile?: (absolutePath: string) => Promise<string>;
  writeFile?: (absolutePath: string, content: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
};

const defaultDeps: Required<CorrectorDeps> = {
  readFile: (p) => fs.readFile(p, "utf8"),
  writeFile: (p, c) => fs.writeFile(p, c, "utf8"),
  rename: (from, to) => fs.rename(from, to),
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

type PendingEdit = {
  startLine: number;
  endLine: number;
  replacement: string[];
};

function buildAnnotation(issue: VerifierIssue, note: string): string {
  const comment = `<!-- dream-police: ${note.replace(/-->/g, "--&gt;")} -->`;
  return [issue.reason ? `${comment} // ${issue.reason}` : comment].join("");
}

function planEdits(actionable: ActionableIssue[]): PendingEdit[] {
  const edits: PendingEdit[] = [];
  for (const { issue, action } of actionable) {
    const { startLine, endLine } = issue.location;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine > endLine) {
      continue;
    }
    if (action.kind === "remove") {
      edits.push({ startLine, endLine, replacement: [] });
    } else if (action.kind === "rewrite") {
      edits.push({
        startLine,
        endLine,
        replacement: action.replacement.split("\n"),
      });
    } else {
      const annotation = buildAnnotation(issue, action.note);
      edits.push({
        startLine: endLine,
        endLine,
        replacement: [annotation],
      });
    }
  }
  return edits.toSorted((a, b) => b.startLine - a.startLine);
}

function applyEdits(originalLines: string[], edits: PendingEdit[]): string[] {
  const lines = [...originalLines];
  for (const edit of edits) {
    const startIndex = Math.max(0, edit.startLine - 1);
    const endIndex = Math.min(lines.length, edit.endLine);
    if (startIndex > endIndex) {
      continue;
    }
    if (edit.replacement.length === 0) {
      lines.splice(startIndex, endIndex - startIndex);
      continue;
    }
    if (
      edit.startLine === edit.endLine &&
      edit.replacement.length === 1 &&
      edit.replacement[0].startsWith("<!-- dream-police:")
    ) {
      lines.splice(endIndex, 0, edit.replacement[0]);
      continue;
    }
    lines.splice(startIndex, endIndex - startIndex, ...edit.replacement);
  }
  return lines;
}

export type CorrectionSummary = {
  appliedEditCount: number;
  affectedIssueKeys: string[];
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

  const actionable = pickActionableIssues(params.critique);
  if (actionable.length === 0) {
    return { appliedEditCount: 0, affectedIssueKeys: [] };
  }

  const absoluteMemoryPath = path.isAbsolute(params.diff.memoryPath)
    ? params.diff.memoryPath
    : path.resolve(params.workspaceDir, params.diff.memoryPath);

  const original = await readFile(absoluteMemoryPath);
  const edits = planEdits(actionable);
  const updatedLines = applyEdits(original.split("\n"), edits);
  const updatedContent = updatedLines.join("\n");

  const tempPath = `${absoluteMemoryPath}.dream-police.tmp`;
  await writeFile(tempPath, updatedContent);
  await rename(tempPath, absoluteMemoryPath);

  return {
    appliedEditCount: edits.length,
    affectedIssueKeys: actionable.map((item) => item.issue.claim),
  };
}
