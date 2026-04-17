import { describe, expect, it } from "vitest";
import { INITIAL_STATE, isTerminal, transition } from "./state-machine.js";
import type { PromotionDiff, StateMachineState, VerifierCritique, VerifierIssue } from "./types.js";

const DIFF: PromotionDiff = {
  memoryPath: "memory/long-term.md",
  appliedAt: "2026-04-16T00:00:00Z",
  candidates: [
    {
      key: "k1",
      sourcePath: "src.md",
      memoryPath: "memory/long-term.md",
      startLine: 10,
      endLine: 12,
      score: 0.9,
      recallCount: 3,
      snippet: "foo",
    },
  ],
  rawBlock: "- claim",
};

const ERROR_ISSUE: VerifierIssue = {
  claim: "the sky is green",
  location: { memoryPath: DIFF.memoryPath, startLine: 10, endLine: 10 },
  reason: "contradicts common knowledge",
  severity: "error",
  suggestedAction: { kind: "remove" },
};

const NEEDS: VerifierCritique = {
  verdict: "needs_revision",
  issues: [ERROR_ISSUE],
  rationale: "one claim is wrong",
  confidence: 0.9,
};

const ACCEPTED: VerifierCritique = {
  verdict: "accepted",
  issues: [],
  rationale: "all claims are supported",
  confidence: 0.95,
};

const UNSALVAGEABLE: VerifierCritique = {
  verdict: "unsalvageable",
  issues: [ERROR_ISSUE],
  rationale: "multiple contradictions",
  confidence: 0.4,
};

const PARAMS = { maxRounds: 2, correctorEnabled: true };

function verifyingAt(roundsUsed: number): StateMachineState {
  return { kind: "verifying", diff: DIFF, roundsUsed };
}

describe("state-machine", () => {
  it("idle + batch_received -> verifying", () => {
    const next = transition(INITIAL_STATE, { kind: "batch_received", diff: DIFF }, PARAMS);
    expect(next.kind).toBe("verifying");
  });

  it("accepted verdict -> terminal accepted", () => {
    const next = transition(
      verifyingAt(0),
      { kind: "critique_returned", critique: ACCEPTED },
      PARAMS,
    );
    expect(next.kind).toBe("accepted");
    expect(isTerminal(next)).toBe(true);
  });

  it("unsalvageable verdict -> flagged", () => {
    const next = transition(
      verifyingAt(0),
      { kind: "critique_returned", critique: UNSALVAGEABLE },
      PARAMS,
    );
    expect(next.kind).toBe("flagged");
    if (next.kind !== "flagged") {
      return;
    }
    expect(next.reason.kind).toBe("unsalvageable");
  });

  it("needs_revision within budget -> correcting", () => {
    const next = transition(verifyingAt(0), { kind: "critique_returned", critique: NEEDS }, PARAMS);
    expect(next.kind).toBe("correcting");
  });

  it("needs_revision at max rounds -> flagged with max_rounds_exceeded", () => {
    const next = transition(verifyingAt(2), { kind: "critique_returned", critique: NEEDS }, PARAMS);
    expect(next.kind).toBe("flagged");
    if (next.kind !== "flagged") {
      return;
    }
    expect(next.reason.kind).toBe("max_rounds_exceeded");
  });

  it("needs_revision with no actionable issues -> accepted (info-only)", () => {
    const infoOnly: VerifierCritique = {
      verdict: "needs_revision",
      issues: [{ ...ERROR_ISSUE, severity: "info" }],
      rationale: "nothing major",
      confidence: 0.8,
    };
    const next = transition(
      verifyingAt(0),
      { kind: "critique_returned", critique: infoOnly },
      PARAMS,
    );
    expect(next.kind).toBe("accepted");
  });

  it("needs_revision with corrector disabled -> flagged immediately", () => {
    const next = transition(
      verifyingAt(0),
      { kind: "critique_returned", critique: NEEDS },
      { ...PARAMS, correctorEnabled: false },
    );
    expect(next.kind).toBe("flagged");
  });

  it("verifier_error -> flagged with error code", () => {
    const next = transition(
      verifyingAt(0),
      { kind: "verifier_error", error: { code: "timeout" } },
      PARAMS,
    );
    expect(next.kind).toBe("flagged");
    if (next.kind !== "flagged") {
      return;
    }
    expect(next.reason.kind).toBe("verifier_error");
  });

  it("correcting + correction_applied -> verifying with rounds incremented", () => {
    const correcting: StateMachineState = {
      kind: "correcting",
      diff: DIFF,
      critique: NEEDS,
      roundsUsed: 0,
    };
    const next = transition(correcting, { kind: "correction_applied" }, PARAMS);
    expect(next.kind).toBe("verifying");
    if (next.kind !== "verifying") {
      return;
    }
    expect(next.roundsUsed).toBe(1);
  });

  it("correcting + corrector_error -> flagged", () => {
    const correcting: StateMachineState = {
      kind: "correcting",
      diff: DIFF,
      critique: NEEDS,
      roundsUsed: 0,
    };
    const next = transition(correcting, { kind: "corrector_error", detail: "boom" }, PARAMS);
    expect(next.kind).toBe("flagged");
    if (next.kind !== "flagged") {
      return;
    }
    expect(next.reason.kind).toBe("corrector_error");
  });

  it("terminal states ignore further events", () => {
    const accepted: StateMachineState = { kind: "accepted", diff: DIFF, roundsUsed: 0 };
    expect(transition(accepted, { kind: "critique_returned", critique: NEEDS }, PARAMS)).toEqual(
      accepted,
    );
    const flagged: StateMachineState = {
      kind: "flagged",
      diff: DIFF,
      roundsUsed: 0,
      reason: { kind: "corrector_error", detail: "x" },
    };
    expect(transition(flagged, { kind: "correction_applied" }, PARAMS)).toEqual(flagged);
  });

  it("maxRounds=0 means first needs_revision escapes immediately", () => {
    const next = transition(
      verifyingAt(0),
      { kind: "critique_returned", critique: NEEDS },
      { ...PARAMS, maxRounds: 0 },
    );
    expect(next.kind).toBe("flagged");
    if (next.kind !== "flagged") {
      return;
    }
    expect(next.reason.kind).toBe("max_rounds_exceeded");
  });
});
