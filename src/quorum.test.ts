import { describe, expect, it } from "vitest";
import type { DreamPoliceProviderConfig } from "./config.js";
import type { PromotionDiff, VerifierCritique } from "./types.js";
import { verifyWithQuorum } from "./quorum.js";
import type { VerifierFetchFn } from "./verifier.js";

const DIFF: PromotionDiff = {
  memoryPath: "memory/long-term.md",
  appliedAt: "2026-04-17T00:00:00Z",
  candidates: [
    {
      key: "k1",
      sourcePath: "a.md",
      memoryPath: "memory/long-term.md",
      startLine: 10,
      endLine: 10,
      score: 0.9,
      recallCount: 3,
      snippet: "- claim",
    },
  ],
  rawBlock: "- claim",
};

function provider(model: string, apiKeyEnv: string): DreamPoliceProviderConfig {
  return {
    baseUrl: `https://api.${model}.example.com/v1`,
    apiKeyEnv,
    model,
    timeoutMs: 5_000,
    headers: {},
  };
}

function respondWith(critique: VerifierCritique): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(critique) } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const A = provider("a", "KEY_A");
const B = provider("b", "KEY_B");
const C = provider("c", "KEY_C");

const ACCEPT: VerifierCritique = {
  verdict: "accepted",
  issues: [],
  rationale: "ok",
  confidence: 0.9,
};

const REVISE: VerifierCritique = {
  verdict: "needs_revision",
  issues: [
    {
      claim: "bad",
      location: { memoryPath: DIFF.memoryPath, startLine: 10, endLine: 10 },
      reason: "unsupported",
      severity: "error",
      suggestedAction: { kind: "remove" },
    },
  ],
  rationale: "needs fix",
  confidence: 0.7,
};

const UNSALV: VerifierCritique = {
  verdict: "unsalvageable",
  issues: [],
  rationale: "multiple contradictions",
  confidence: 0.3,
};

describe("verifyWithQuorum", () => {
  it("conservative policy: any unsalvageable wins", async () => {
    const fetchFn: VerifierFetchFn = async (url) => {
      if (url.includes("api.a")) return respondWith(ACCEPT);
      if (url.includes("api.b")) return respondWith(ACCEPT);
      return respondWith(UNSALV);
    };
    const result = await verifyWithQuorum(
      { diff: DIFF, priorContext: "", providers: [A, B, C], policy: "conservative" },
      { fetch: fetchFn, readEnv: () => "key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.critique.verdict).toBe("unsalvageable");
  });

  it("unanimous policy: single dissent downgrades from accepted", async () => {
    const fetchFn: VerifierFetchFn = async (url) => {
      if (url.includes("api.a")) return respondWith(ACCEPT);
      if (url.includes("api.b")) return respondWith(ACCEPT);
      return respondWith(REVISE);
    };
    const result = await verifyWithQuorum(
      { diff: DIFF, priorContext: "", providers: [A, B, C], policy: "unanimous" },
      { fetch: fetchFn, readEnv: () => "key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.critique.verdict).toBe("needs_revision");
    expect(result.critique.issues.length).toBe(1);
  });

  it("majority policy: two needs_revision beats one accepted", async () => {
    const fetchFn: VerifierFetchFn = async (url) => {
      if (url.includes("api.a")) return respondWith(REVISE);
      if (url.includes("api.b")) return respondWith(REVISE);
      return respondWith(ACCEPT);
    };
    const result = await verifyWithQuorum(
      { diff: DIFF, priorContext: "", providers: [A, B, C], policy: "majority" },
      { fetch: fetchFn, readEnv: () => "key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.critique.verdict).toBe("needs_revision");
  });

  it("returns a network error when every voter fails", async () => {
    const fetchFn: VerifierFetchFn = async () => new Response("down", { status: 503 });
    const result = await verifyWithQuorum(
      { diff: DIFF, priorContext: "", providers: [A, B], policy: "conservative" },
      { fetch: fetchFn, readEnv: () => "key" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("http_error");
  });

  it("merges issues across voters without duplicates", async () => {
    const otherClaim: VerifierCritique = {
      ...REVISE,
      issues: [
        {
          ...REVISE.issues[0],
          claim: "different",
          location: { memoryPath: DIFF.memoryPath, startLine: 11, endLine: 11 },
        },
      ],
    };
    const fetchFn: VerifierFetchFn = async (url) => {
      if (url.includes("api.a")) return respondWith(REVISE);
      return respondWith(otherClaim);
    };
    const result = await verifyWithQuorum(
      { diff: DIFF, priorContext: "", providers: [A, B], policy: "conservative" },
      { fetch: fetchFn, readEnv: () => "key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.critique.issues.length).toBe(2);
  });
});
