import { describe, expect, it } from "vitest";
import { appendHistoryEntry, readRecentHistory, renderHistoryEntry } from "./history.js";

describe("renderHistoryEntry", () => {
  it("renders a compact markdown block with timestamp, outcome, and candidates", () => {
    const rendered = renderHistoryEntry({
      timestamp: "2026-04-17T00:00:00Z",
      outcome: "accepted",
      memoryPath: "memory/long-term.md",
      candidateKeys: ["k1", "k2"],
      rounds: 0,
      confidence: 0.94,
      rationale: "all claims supported",
    });
    expect(rendered).toContain("**2026-04-17T00:00:00Z**");
    expect(rendered).toContain("[accepted]");
    expect(rendered).toContain("confidence=0.94");
    expect(rendered).toContain("candidates: k1, k2");
    expect(rendered).toContain("rationale: all claims supported");
  });
});

describe("appendHistoryEntry + readRecentHistory", () => {
  it("appends entries and returns only the last `limit` blocks", async () => {
    let store = "";
    for (let i = 0; i < 5; i += 1) {
      await appendHistoryEntry({
        workspaceDir: "/ws",
        historyFile: "memory/DREAMS_LOG.md",
        entry: {
          timestamp: `2026-04-17T00:00:0${i}Z`,
          outcome: "accepted",
          memoryPath: "memory/long-term.md",
          candidateKeys: [`k${i}`],
          rounds: 0,
        },
        deps: {
          appendFile: async (_path, content) => {
            store += content;
          },
          mkdir: async () => {},
        },
      });
    }
    const recent = await readRecentHistory({
      workspaceDir: "/ws",
      historyFile: "memory/DREAMS_LOG.md",
      limit: 2,
      deps: {
        readFile: async () => store,
        fileExists: async () => true,
      },
    });
    expect(recent).toContain("k3");
    expect(recent).toContain("k4");
    expect(recent).not.toContain("k0");
    expect(recent).not.toContain("k1");
  });

  it("returns empty string when the history file does not exist", async () => {
    const recent = await readRecentHistory({
      workspaceDir: "/ws",
      historyFile: "memory/DREAMS_LOG.md",
      deps: {
        readFile: async () => "",
        fileExists: async () => false,
      },
    });
    expect(recent).toBe("");
  });
});
