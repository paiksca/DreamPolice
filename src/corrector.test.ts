import { describe, expect, it } from "vitest";
import { applyCorrection } from "./corrector.js";
import type { PromotionDiff, VerifierCritique } from "./types.js";

const ORIGINAL = [
  "# Memory",
  "",
  "## Promoted",
  "- claim one",
  "- claim two (wrong)",
  "- claim three",
  "",
].join("\n");

const DIFF: PromotionDiff = {
  memoryPath: "memory/long-term.md",
  appliedAt: "2026-04-16T00:00:00Z",
  candidates: [],
  rawBlock: "",
};

function critique(overrides: Partial<VerifierCritique>): VerifierCritique {
  return {
    verdict: "needs_revision",
    issues: [],
    rationale: "test",
    confidence: 0.9,
    ...overrides,
  };
}

describe("applyCorrection", () => {
  it("removes a line when suggestedAction is remove", async () => {
    let written = "";
    const summary = await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        issues: [
          {
            claim: "claim two is wrong",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 5 },
            reason: "not supported",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    expect(summary.appliedEditCount).toBe(1);
    expect(written).not.toContain("claim two (wrong)");
    expect(written).toContain("claim one");
    expect(written).toContain("claim three");
  });

  it("rewrites a line when confidence is above threshold", async () => {
    let written = "";
    await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        confidence: 0.9,
        issues: [
          {
            claim: "claim two is wrong",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 5 },
            reason: "should be fixed",
            severity: "error",
            suggestedAction: { kind: "rewrite", replacement: "- claim two (fixed)" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    expect(written).toContain("- claim two (fixed)");
    expect(written).not.toContain("- claim two (wrong)");
  });

  it("downgrades rewrite to annotate when confidence is below threshold", async () => {
    let written = "";
    await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        confidence: 0.3,
        issues: [
          {
            claim: "claim two maybe wrong",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 5 },
            reason: "uncertain",
            severity: "warn",
            suggestedAction: { kind: "rewrite", replacement: "- not used" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    expect(written).toContain("- claim two (wrong)");
    expect(written).toContain("<!-- dream-police:");
  });

  it("skips info-severity issues", async () => {
    let writeCalled = false;
    const summary = await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        issues: [
          {
            claim: "info only",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 5 },
            reason: "nit",
            severity: "info",
            suggestedAction: { kind: "remove" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async () => {
          writeCalled = true;
        },
        rename: async () => {},
      },
    });
    expect(summary.appliedEditCount).toBe(0);
    expect(writeCalled).toBe(false);
  });

  it("inserts an annotation comment next to the affected line when suggestedAction is annotate", async () => {
    let written = "";
    await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        confidence: 0.9,
        issues: [
          {
            claim: "claim two needs context",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 5 },
            reason: "source cited but unverified",
            severity: "warn",
            suggestedAction: { kind: "annotate", note: "unverified source" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    expect(written).toContain("- claim two (wrong)");
    expect(written).toContain("<!-- dream-police: unverified source -->");
    // Order preserved: original line then annotation
    const lines = written.split("\n");
    const originalIdx = lines.findIndex((l) => l.includes("- claim two (wrong)"));
    const annotIdx = lines.findIndex((l) => l.includes("<!-- dream-police: unverified source -->"));
    expect(annotIdx).toBe(originalIdx + 1);
  });

  it("does not treat user-authored `<!-- dream-police:` rewrites as insertions", async () => {
    let written = "";
    await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        confidence: 0.9,
        issues: [
          {
            claim: "odd rewrite",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 5 },
            reason: "replace with comment-like text",
            severity: "error",
            suggestedAction: {
              kind: "rewrite",
              replacement: "<!-- dream-police: user-authored -->",
            },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    // Original line must be gone and replaced, not duplicated next to an insertion.
    expect(written).not.toContain("- claim two (wrong)");
    expect(written).toContain("<!-- dream-police: user-authored -->");
  });

  it("drops overlapping edits instead of corrupting the file", async () => {
    let written = "";
    const summary = await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        issues: [
          {
            claim: "range a",
            location: { memoryPath: "memory/long-term.md", startLine: 4, endLine: 6 },
            reason: "bad",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
          {
            claim: "range b overlapping",
            location: { memoryPath: "memory/long-term.md", startLine: 5, endLine: 7 },
            reason: "bad",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    expect(summary.appliedEditCount).toBe(1);
    expect(written).not.toContain("claim one");
  });

  it("applies multiple edits in reverse line order so earlier edits do not shift later line numbers", async () => {
    let written = "";
    await applyCorrection({
      workspaceDir: "/ws",
      diff: DIFF,
      critique: critique({
        issues: [
          {
            claim: "claim one wrong",
            location: { memoryPath: "memory/long-term.md", startLine: 4, endLine: 4 },
            reason: "bad",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
          {
            claim: "claim three wrong",
            location: { memoryPath: "memory/long-term.md", startLine: 6, endLine: 6 },
            reason: "bad",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
        ],
      }),
      deps: {
        readFile: async () => ORIGINAL,
        writeFile: async (_, content) => {
          written = content;
        },
        rename: async () => {},
      },
    });
    expect(written).not.toContain("claim one");
    expect(written).not.toContain("claim three");
    expect(written).toContain("claim two (wrong)");
  });
});
