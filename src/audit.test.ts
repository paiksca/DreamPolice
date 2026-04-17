import { describe, expect, it } from "vitest";
import { appendAuditEntry, renderAuditEntry } from "./audit.js";
import type { AuditEntry } from "./types.js";

const ENTRY: AuditEntry = {
  timestamp: "2026-04-16T00:00:00Z",
  memoryPath: "memory/long-term.md",
  candidateKeys: ["k1", "k2"],
  roundsAttempted: 2,
  finalVerdict: "needs_revision",
  issues: [
    {
      claim: "the sky is green",
      location: { memoryPath: "memory/long-term.md", startLine: 10, endLine: 10 },
      reason: "contradicts source",
      severity: "error",
      suggestedAction: { kind: "remove" },
    },
  ],
  rationale: "one unsupported claim survived correction",
};

describe("renderAuditEntry", () => {
  it("produces a deterministic, append-friendly markdown block", () => {
    const rendered = renderAuditEntry(ENTRY);
    expect(rendered).toContain("## 2026-04-16T00:00:00Z — needs_revision");
    expect(rendered).toContain("candidateKeys: k1, k2");
    expect(rendered).toContain("roundsAttempted: 2");
    expect(rendered).toContain("(error) the sky is green");
    expect(rendered.endsWith("\n\n")).toBe(true);
  });

  it("handles empty issues gracefully", () => {
    const rendered = renderAuditEntry({ ...ENTRY, issues: [] });
    expect(rendered).toContain("(no structured issues returned)");
  });
});

describe("appendAuditEntry", () => {
  it("resolves relative paths against workspace and appends only", async () => {
    const appendCalls: Array<{ path: string; content: string }> = [];
    const mkdirCalls: string[] = [];
    const absolutePath = await appendAuditEntry({
      workspaceDir: "/ws",
      auditFile: "memory/DREAMS_POLICE.md",
      entry: ENTRY,
      deps: {
        appendFile: async (path, content) => {
          appendCalls.push({ path, content });
        },
        mkdir: async (path) => {
          mkdirCalls.push(path);
        },
      },
    });
    expect(absolutePath).toBe("/ws/memory/DREAMS_POLICE.md");
    expect(mkdirCalls[0]).toBe("/ws/memory");
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].path).toBe("/ws/memory/DREAMS_POLICE.md");
  });
});
