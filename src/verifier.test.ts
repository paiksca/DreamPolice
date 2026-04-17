import { describe, expect, it } from "vitest";
import type { DreamPoliceProviderConfig } from "./config.js";
import type { PromotionDiff, VerifierCritique } from "./types.js";
import { verifyPromotion, type VerifierFetchFn } from "./verifier.js";

const PROVIDER: DreamPoliceProviderConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKeyEnv: "DP_TEST_KEY",
  model: "m",
  timeoutMs: 500,
  headers: {},
};

const DIFF: PromotionDiff = {
  memoryPath: "memory/long-term.md",
  appliedAt: "2026-04-16T00:00:00Z",
  candidates: [
    {
      key: "k1",
      sourcePath: "a.md",
      memoryPath: "memory/long-term.md",
      startLine: 10,
      endLine: 10,
      score: 0.9,
      recallCount: 3,
      snippet: "- the sky is blue",
    },
  ],
  rawBlock: "- the sky is blue",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okCritique(critique: VerifierCritique) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify(critique) } }] });
}

function garbageResponse() {
  return jsonResponse({ choices: [{ message: { content: "not-json-at-all" } }] });
}

describe("verifyPromotion", () => {
  it("returns accepted critique when verifier returns valid JSON", async () => {
    const fetch: VerifierFetchFn = async () =>
      okCritique({ verdict: "accepted", issues: [], rationale: "looks fine", confidence: 0.9 });
    const result = await verifyPromotion(
      { diff: DIFF, provider: PROVIDER, priorContext: "" },
      { fetch, readEnv: () => "test-key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.critique.verdict).toBe("accepted");
  });

  it("retries once on malformed JSON then succeeds", async () => {
    let call = 0;
    const fetch: VerifierFetchFn = async () => {
      call += 1;
      if (call === 1) {
        return garbageResponse();
      }
      return okCritique({
        verdict: "needs_revision",
        issues: [
          {
            claim: "sky green",
            location: { memoryPath: DIFF.memoryPath, startLine: 10, endLine: 10 },
            reason: "wrong",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
        ],
        rationale: "one error",
        confidence: 0.7,
      });
    };
    const result = await verifyPromotion(
      { diff: DIFF, provider: PROVIDER, priorContext: "" },
      { fetch, readEnv: () => "test-key" },
    );
    expect(call).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.critique.verdict).toBe("needs_revision");
  });

  it("declares unsalvageable after two malformed JSON responses", async () => {
    const fetch: VerifierFetchFn = async () => garbageResponse();
    const result = await verifyPromotion(
      { diff: DIFF, provider: PROVIDER, priorContext: "" },
      { fetch, readEnv: () => "test-key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.critique.verdict).toBe("unsalvageable");
  });

  it("returns http_error when response is non-2xx", async () => {
    const fetch: VerifierFetchFn = async () => new Response("down", { status: 503 });
    const result = await verifyPromotion(
      { diff: DIFF, provider: PROVIDER, priorContext: "" },
      { fetch, readEnv: () => "test-key" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("http_error");
  });

  it("returns network error when env var is missing", async () => {
    const fetch: VerifierFetchFn = async () => new Response("{}", { status: 200 });
    const result = await verifyPromotion(
      { diff: DIFF, provider: PROVIDER, priorContext: "" },
      { fetch, readEnv: () => undefined },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("network");
  });

  it("sorts issues deterministically by location", async () => {
    const fetch: VerifierFetchFn = async () =>
      okCritique({
        verdict: "needs_revision",
        issues: [
          {
            claim: "b",
            location: { memoryPath: "m.md", startLine: 20, endLine: 20 },
            reason: "r",
            severity: "warn",
            suggestedAction: { kind: "annotate", note: "n" },
          },
          {
            claim: "a",
            location: { memoryPath: "m.md", startLine: 10, endLine: 10 },
            reason: "r",
            severity: "error",
            suggestedAction: { kind: "remove" },
          },
        ],
        rationale: "two issues",
        confidence: 0.8,
      });
    const result = await verifyPromotion(
      { diff: DIFF, provider: PROVIDER, priorContext: "" },
      { fetch, readEnv: () => "test-key" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.critique.issues[0].location.startLine).toBe(10);
    expect(result.critique.issues[1].location.startLine).toBe(20);
  });
});
