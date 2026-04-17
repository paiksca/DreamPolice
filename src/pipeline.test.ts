import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryHostPromotionAppliedEvent, PluginLogger } from "../api.js";
import { resolveDreamPoliceConfig } from "./config.js";
import { processPromotionEvent } from "./pipeline.js";

const MEMORY_CONTENT = [
  "# Long-term memory",
  "",
  "## Notes",
  "- prior claim",
  "",
  "## Promoted",
  "- the sky is green",
  "- water freezes at 0C",
  "",
].join("\n");

const silentLogger: PluginLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function event(): MemoryHostPromotionAppliedEvent {
  return {
    type: "memory.promotion.applied",
    timestamp: "2026-04-16T00:00:00Z",
    memoryPath: "memory/long-term.md",
    applied: 2,
    candidates: [
      { key: "k1", path: "a.md", startLine: 7, endLine: 7, score: 0.9, recallCount: 3 },
      { key: "k2", path: "b.md", startLine: 8, endLine: 8, score: 0.8, recallCount: 2 },
    ],
  };
}

const BASE_CONFIG = resolveDreamPoliceConfig({
  enabled: true,
  verifier: {
    provider: {
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "DP_KEY",
      model: "m",
    },
  },
  retry: { maxRounds: 2 },
  pollIntervalMs: 1000,
});

describe("processPromotionEvent", () => {
  let memoryState: string;
  let auditPath: string | null;
  let auditContent: string;

  beforeEach(() => {
    memoryState = MEMORY_CONTENT;
    auditPath = null;
    auditContent = "";
  });

  const testDeps = {
    readFile: async () => memoryState,
    corrector: {
      readFile: async () => memoryState,
      writeFile: async (_: string, content: string) => {
        memoryState = content;
      },
      rename: async () => {},
    },
    audit: {
      appendFile: async (path: string, content: string) => {
        auditPath = path;
        auditContent += content;
      },
      mkdir: async () => {},
    },
    readEnv: () => "test-key",
  };

  it("accepts when verifier returns verdict=accepted and writes no audit entry", async () => {
    const result = await processPromotionEvent({
      workspaceDir: "/ws",
      config: BASE_CONFIG,
      event: event(),
      logger: silentLogger,
      deps: {
        ...testDeps,
        verifier: {
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        verdict: "accepted",
                        issues: [],
                        rationale: "ok",
                        confidence: 0.9,
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      },
    });
    expect(result.finalState.kind).toBe("accepted");
    expect(auditContent).toBe("");
  });

  it("runs correction loop and re-verifies to ACCEPTED", async () => {
    let call = 0;
    const result = await processPromotionEvent({
      workspaceDir: "/ws",
      config: BASE_CONFIG,
      event: event(),
      logger: silentLogger,
      deps: {
        ...testDeps,
        verifier: {
          fetch: async () => {
            call += 1;
            const critique =
              call === 1
                ? {
                    verdict: "needs_revision",
                    issues: [
                      {
                        claim: "the sky is green",
                        location: { memoryPath: "memory/long-term.md", startLine: 7, endLine: 7 },
                        reason: "not supported",
                        severity: "error",
                        suggestedAction: { kind: "remove" },
                      },
                    ],
                    rationale: "one unsupported claim",
                    confidence: 0.9,
                  }
                : {
                    verdict: "accepted",
                    issues: [],
                    rationale: "looks fine now",
                    confidence: 0.9,
                  };
            return new Response(
              JSON.stringify({ choices: [{ message: { content: JSON.stringify(critique) } }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      },
    });
    expect(call).toBe(2);
    expect(result.finalState.kind).toBe("accepted");
    expect(memoryState).not.toContain("the sky is green");
    expect(auditContent).toBe("");
  });

  it("flags after exhausting maxRounds and writes an audit entry (no revert)", async () => {
    const result = await processPromotionEvent({
      workspaceDir: "/ws",
      config: BASE_CONFIG,
      event: event(),
      logger: silentLogger,
      deps: {
        ...testDeps,
        verifier: {
          fetch: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        verdict: "needs_revision",
                        issues: [
                          {
                            claim: "water freezes at 0C",
                            location: {
                              memoryPath: "memory/long-term.md",
                              startLine: 8,
                              endLine: 8,
                            },
                            reason: "still unsupported",
                            severity: "error",
                            suggestedAction: { kind: "remove" },
                          },
                        ],
                        rationale: "still failing",
                        confidence: 0.9,
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      },
    });
    expect(result.finalState.kind).toBe("flagged");
    expect(auditPath).toBe("/ws/memory/DREAMS_POLICE.md");
    expect(auditContent).toContain("needs_revision");
    expect(auditContent).toContain("roundsAttempted: 2");
  });

  it("flags with verdict=unsalvageable on unsalvageable verdict and never attempts correction", async () => {
    let call = 0;
    const result = await processPromotionEvent({
      workspaceDir: "/ws",
      config: BASE_CONFIG,
      event: event(),
      logger: silentLogger,
      deps: {
        ...testDeps,
        verifier: {
          fetch: async () => {
            call += 1;
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        verdict: "unsalvageable",
                        issues: [],
                        rationale: "multiple contradictions with prior memory",
                        confidence: 0.2,
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      },
    });
    expect(call).toBe(1);
    expect(result.finalState.kind).toBe("flagged");
    expect(auditContent).toContain("unsalvageable");
    expect(auditContent).toContain("multiple contradictions");
  });

  it("dry-run mode: no writes to memory or audit, but verifier still runs", async () => {
    const dryConfig = resolveDreamPoliceConfig({
      enabled: true,
      dryRun: true,
      verifier: {
        provider: {
          baseUrl: "https://api.example.com/v1",
          apiKeyEnv: "DP_KEY",
          model: "m",
        },
      },
    });
    let call = 0;
    const memoryAtStart = memoryState;
    const result = await processPromotionEvent({
      workspaceDir: "/ws",
      config: dryConfig,
      event: event(),
      logger: silentLogger,
      deps: {
        ...testDeps,
        verifier: {
          fetch: async () => {
            call += 1;
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        verdict: "needs_revision",
                        issues: [
                          {
                            claim: "sky is green",
                            location: { memoryPath: "memory/long-term.md", startLine: 7, endLine: 7 },
                            reason: "wrong",
                            severity: "error",
                            suggestedAction: { kind: "remove" },
                          },
                        ],
                        rationale: "one wrong claim",
                        confidence: 0.9,
                      }),
                    },
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        },
      },
    });
    // Verifier still called (we want its opinion) but memory + audit untouched.
    expect(call).toBeGreaterThanOrEqual(1);
    expect(memoryState).toBe(memoryAtStart);
    expect(auditContent).toBe("");
    expect(result.dryRun).toBe(true);
  });

  it("writes a privacy-flag audit entry when onSensitive=flag matches", async () => {
    const sensitiveConfig = resolveDreamPoliceConfig({
      enabled: true,
      verifier: {
        provider: {
          baseUrl: "https://api.example.com/v1",
          apiKeyEnv: "DP_KEY",
          model: "m",
        },
      },
      sensitivity: { onSensitive: "flag", tags: ["secret"] },
    });
    memoryState = MEMORY_CONTENT.replace("the sky is green", "<!-- tag:secret --> classified");
    const result = await processPromotionEvent({
      workspaceDir: "/ws",
      config: sensitiveConfig,
      event: event(),
      logger: silentLogger,
      deps: testDeps,
    });
    expect(result.skippedReason).toBeDefined();
    expect(auditContent).toContain("needs_revision");
    expect(auditContent).toContain("flagged by privacy policy");
  });
});
