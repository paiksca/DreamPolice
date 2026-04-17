import { describe, expect, it } from "vitest";
import type { MemoryHostPromotionAppliedEvent } from "../api.js";
import { buildPromotionDiff } from "./diff.js";

const MEMORY = [
  "# Long-term memory",
  "",
  "## Notes",
  "- The sky is blue",
  "- Water boils at 100C",
  "",
  "## Promoted 2026-04-16",
  "- claim one",
  "- claim two",
  "- claim three",
  "",
].join("\n");

function eventFor(
  overrides: Partial<MemoryHostPromotionAppliedEvent> = {},
): MemoryHostPromotionAppliedEvent {
  return {
    type: "memory.promotion.applied",
    timestamp: "2026-04-16T00:00:00Z",
    memoryPath: "memory/long-term.md",
    applied: 2,
    candidates: [
      {
        key: "k1",
        path: "a.md",
        startLine: 8,
        endLine: 8,
        score: 0.9,
        recallCount: 3,
      },
      {
        key: "k2",
        path: "b.md",
        startLine: 9,
        endLine: 10,
        score: 0.8,
        recallCount: 2,
      },
    ],
    ...overrides,
  };
}

describe("buildPromotionDiff", () => {
  it("slices each candidate's lines and computes the block range", async () => {
    const diff = await buildPromotionDiff("/ws", eventFor(), {
      readFile: async () => MEMORY,
    });
    expect(diff).not.toBeNull();
    if (!diff) {
      return;
    }
    expect(diff.candidates[0].snippet).toBe("- claim one");
    expect(diff.candidates[1].snippet).toBe(["- claim two", "- claim three"].join("\n"));
    expect(diff.rawBlock).toBe(["- claim one", "- claim two", "- claim three"].join("\n"));
    expect(diff.memoryPath).toBe("memory/long-term.md");
  });

  it("returns null when applied is zero", async () => {
    const diff = await buildPromotionDiff("/ws", eventFor({ applied: 0 }), {
      readFile: async () => MEMORY,
    });
    expect(diff).toBeNull();
  });

  it("returns null when there are no candidates", async () => {
    const diff = await buildPromotionDiff("/ws", eventFor({ candidates: [], applied: 0 }), {
      readFile: async () => MEMORY,
    });
    expect(diff).toBeNull();
  });

  it("handles a candidate range that extends past file end gracefully", async () => {
    const diff = await buildPromotionDiff(
      "/ws",
      eventFor({
        candidates: [
          {
            key: "k1",
            path: "a.md",
            startLine: 10,
            endLine: 99,
            score: 0.5,
            recallCount: 1,
          },
        ],
        applied: 1,
      }),
      { readFile: async () => MEMORY },
    );
    expect(diff).not.toBeNull();
    if (!diff) {
      return;
    }
    expect(diff.candidates[0].snippet.length).toBeGreaterThan(0);
  });

  it("resolves relative memoryPath against workspaceDir", async () => {
    let seen = "";
    await buildPromotionDiff("/ws", eventFor(), {
      readFile: async (p) => {
        seen = p;
        return MEMORY;
      },
    });
    expect(seen).toBe("/ws/memory/long-term.md");
  });
});
