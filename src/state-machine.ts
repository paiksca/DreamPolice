import type {
  FlagReason,
  PromotionDiff,
  StateEvent,
  StateMachineState,
  VerifierCritique,
} from "./types.js";

export type TransitionParams = {
  maxRounds: number;
  watchdogMs: number;
  correctorEnabled: boolean;
};

export const INITIAL_STATE: StateMachineState = { kind: "idle" };

function hasActionableIssue(critique: VerifierCritique): boolean {
  return critique.issues.some((issue) => issue.severity === "warn" || issue.severity === "error");
}

export function transition(
  state: StateMachineState,
  event: StateEvent,
  params: TransitionParams,
): StateMachineState {
  switch (state.kind) {
    case "idle": {
      if (event.kind === "batch_received") {
        return {
          kind: "verifying",
          diff: event.diff,
          roundsUsed: 0,
          startedAt: event.now,
        };
      }
      return state;
    }

    case "verifying": {
      if (event.kind === "watchdog_fired") {
        if (event.now - state.startedAt >= params.watchdogMs) {
          return flagged(state.diff, { kind: "watchdog_timeout" }, state.roundsUsed);
        }
        return state;
      }
      if (event.kind === "verifier_error") {
        return flagged(
          state.diff,
          { kind: "verifier_error", error: event.error },
          state.roundsUsed,
        );
      }
      if (event.kind === "critique_returned") {
        return handleCritique(state.diff, event.critique, state.roundsUsed, params);
      }
      return state;
    }

    case "correcting": {
      if (event.kind === "corrector_error") {
        return flagged(
          state.diff,
          { kind: "corrector_error", detail: event.detail },
          state.roundsUsed,
        );
      }
      if (event.kind === "correction_applied") {
        return {
          kind: "verifying",
          diff: state.diff,
          roundsUsed: state.roundsUsed + 1,
          startedAt: Date.now(),
        };
      }
      return state;
    }

    case "accepted":
    case "flagged":
      return state;
    default:
      return assertNever(state);
  }
}

function assertNever(_: never): never {
  throw new Error("state-machine: unreachable state");
}

function handleCritique(
  diff: PromotionDiff,
  critique: VerifierCritique,
  roundsUsed: number,
  params: TransitionParams,
): StateMachineState {
  if (critique.verdict === "accepted") {
    return { kind: "accepted", diff, roundsUsed };
  }
  if (critique.verdict === "unsalvageable") {
    return flagged(diff, { kind: "unsalvageable", rationale: critique.rationale }, roundsUsed);
  }
  if (!hasActionableIssue(critique)) {
    return { kind: "accepted", diff, roundsUsed };
  }
  if (!params.correctorEnabled) {
    return flagged(
      diff,
      { kind: "max_rounds_exceeded", lastRationale: critique.rationale },
      roundsUsed,
    );
  }
  if (roundsUsed >= params.maxRounds) {
    return flagged(
      diff,
      { kind: "max_rounds_exceeded", lastRationale: critique.rationale },
      roundsUsed,
    );
  }
  return { kind: "correcting", diff, critique, roundsUsed };
}

function flagged(diff: PromotionDiff, reason: FlagReason, roundsUsed: number): StateMachineState {
  return { kind: "flagged", diff, reason, roundsUsed };
}

export function isTerminal(state: StateMachineState): boolean {
  return state.kind === "accepted" || state.kind === "flagged";
}
