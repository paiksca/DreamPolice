import fs from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "./types.js";

export type AuditDeps = {
  appendFile?: (absolutePath: string, content: string) => Promise<void>;
  mkdir?: (absolutePath: string) => Promise<void>;
};

const defaultAppend = (p: string, content: string) => fs.appendFile(p, content, "utf8");
const defaultMkdir = (p: string) => fs.mkdir(p, { recursive: true }).then(() => undefined);

function formatIssues(entry: AuditEntry): string {
  if (entry.issues.length === 0) {
    return "- (no structured issues returned)";
  }
  return entry.issues
    .map((issue) => {
      const loc = `${issue.location.memoryPath}:${issue.location.startLine}-${issue.location.endLine}`;
      return `- (${issue.severity}) ${issue.claim} @ ${loc} — ${issue.reason}`;
    })
    .join("\n");
}

export function renderAuditEntry(entry: AuditEntry): string {
  const keys = entry.candidateKeys.length > 0 ? entry.candidateKeys.join(", ") : "(none)";
  const note = entry.note ? `\n- note: ${entry.note}` : "";
  return [
    `## ${entry.timestamp} — ${entry.finalVerdict}`,
    `- memoryPath: ${entry.memoryPath}`,
    `- candidateKeys: ${keys}`,
    `- roundsAttempted: ${entry.roundsAttempted}`,
    `- rationale: ${entry.rationale}${note}`,
    "- issues:",
    formatIssues(entry),
    "",
    "",
  ].join("\n");
}

export async function appendAuditEntry(params: {
  workspaceDir: string;
  auditFile: string;
  entry: AuditEntry;
  deps?: AuditDeps;
}): Promise<string> {
  const appendFile = params.deps?.appendFile ?? defaultAppend;
  const mkdir = params.deps?.mkdir ?? defaultMkdir;
  const absolutePath = path.isAbsolute(params.auditFile)
    ? params.auditFile
    : path.resolve(params.workspaceDir, params.auditFile);
  await mkdir(path.dirname(absolutePath));
  await appendFile(absolutePath, renderAuditEntry(params.entry));
  return absolutePath;
}
