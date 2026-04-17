import { describe, expect, it } from "vitest";
import { emitDreamPoliceEvent } from "./events.js";

describe("emitDreamPoliceEvent", () => {
  it("serializes an event as a single JSONL line to the resolved path", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
    await emitDreamPoliceEvent({
      workspaceDir: "/ws",
      relativeFile: "memory/.dreams/.dream-police/events.jsonl",
      event: {
        type: "dreamPolice.verified",
        timestamp: "2026-04-17T00:00:00Z",
        memoryPath: "memory/long-term.md",
        candidateKeys: ["k1"],
        verdict: "accepted",
        confidence: 0.9,
        rounds: 0,
      },
      deps: {
        appendFile: async (path, content) => {
          writes.push({ path, content });
        },
        mkdir: async (path) => {
          mkdirs.push(path);
        },
      },
    });
    expect(mkdirs[0]).toBe("/ws/memory/.dreams/.dream-police");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/ws/memory/.dreams/.dream-police/events.jsonl");
    expect(writes[0].content.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(writes[0].content.trim());
    expect(parsed.type).toBe("dreamPolice.verified");
    expect(parsed.verdict).toBe("accepted");
  });
});
