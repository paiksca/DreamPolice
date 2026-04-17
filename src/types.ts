import type { MemoryHostPromotionAppliedEvent } from "../api.js";

export type DreamPhase = "light" | "deep" | "rem";

export type SuggestedAction =
  | { kind: "remove" }
  | { kind: "rewrite"; replacement: string }
  | { kind: "annotate"; note: string };

export type VerifierIssue = {
  claim: string;
  location: {
    memoryPath: string;
    startLine: number;
    endLine: number;
  };
  reason: string;
  severity: "info" | "warn" | "error";
  suggestedAction: SuggestedAction;
};

export type VerifierVerdict = "accepted" | "needs_revision" | "unsalvageable";

export type VerifierCritique = {
  verdict: VerifierVerdict;
  issues: VerifierIssue[];
  rationale: string;
  confidence: number;
};

export type PromotionCandidateSlice = {
  key: string;
  sourcePath: string;
  memoryPath: string;
  startLine: number;
  endLine: number;
  score: number;
  recallCount: number;
  snippet: string;
};

export type PromotionDiff = {
  memoryPath: string;
  appliedAt: string;
  candidates: PromotionCandidateSlice[];
  rawBlock: string;
};

export type VerifierError =
  | { code: "timeout" }
  | { code: "http_error"; status: number }
  | { code: "bad_json" }
  | { code: "network"; detail: string };

export type StateMachineState =
  | { kind: "idle" }
  | { kind: "verifying"; diff: PromotionDiff; roundsUsed: number; startedAt: number }
  | { kind: "correcting"; diff: PromotionDiff; critique: VerifierCritique; roundsUsed: number }
  | { kind: "accepted"; diff: PromotionDiff; roundsUsed: number }
  | { kind: "flagged"; diff: PromotionDiff; reason: FlagReason; roundsUsed: number };

export type FlagReason =
  | { kind: "unsalvageable"; rationale: string }
  | { kind: "max_rounds_exceeded"; lastRationale: string }
  | { kind: "verifier_error"; error: VerifierError }
  | { kind: "corrector_error"; detail: string }
  | { kind: "watchdog_timeout" };

export type StateEvent =
  | { kind: "batch_received"; diff: PromotionDiff; now: number }
  | { kind: "critique_returned"; critique: VerifierCritique }
  | { kind: "correction_applied" }
  | { kind: "verifier_error"; error: VerifierError }
  | { kind: "corrector_error"; detail: string }
  | { kind: "watchdog_fired"; now: number };

export type DreamPoliceEventSource = MemoryHostPromotionAppliedEvent;

export type AuditEntry = {
  timestamp: string;
  memoryPath: string;
  candidateKeys: string[];
  roundsAttempted: number;
  finalVerdict: VerifierVerdict | "error";
  issues: VerifierIssue[];
  rationale: string;
  note?: string;
};
