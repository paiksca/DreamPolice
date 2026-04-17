import type { MemoryHostPromotionAppliedEvent, PluginLogger } from "../api.js";
import { appendAuditEntry } from "./audit.js";
import type { ResolvedDreamPoliceConfig } from "./config.js";
import { applyCorrection } from "./corrector.js";
import { buildPromotionDiff, buildPriorContext, type ReadFileFn } from "./diff.js";
import { applyPrivacyPolicy } from "./privacy.js";
import { INITIAL_STATE, isTerminal, transition, type TransitionParams } from "./state-machine.js";
import type {
  AuditEntry,
  FlagReason,
  PromotionDiff,
  StateMachineState,
  VerifierCritique,
} from "./types.js";
import { verifyPromotion, type VerifierDeps } from "./verifier.js";

export type PipelineDeps = {
  readFile?: ReadFileFn;
  verifier?: VerifierDeps;
  corrector?: Parameters<typeof applyCorrection>[0]["deps"];
  audit?: Parameters<typeof appendAuditEntry>[0]["deps"];
  readEnv?: (name: string) => string | undefined;
  now?: () => number;
};

export type PipelineResult = {
  finalState: StateMachineState;
  roundsUsed: number;
  diff: PromotionDiff | null;
  skippedReason?: string;
};

function assertNever(reason: never): never {
  throw new Error(`pipeline: unreachable flag reason ${JSON.stringify(reason)}`);
}

function reasonToVerdict(reason: FlagReason): "needs_revision" | "unsalvageable" | "error" {
  switch (reason.kind) {
    case "unsalvageable":
      return "unsalvageable";
    case "max_rounds_exceeded":
      return "needs_revision";
    case "verifier_error":
    case "corrector_error":
      return "error";
    default:
      return assertNever(reason);
  }
}

function reasonToRationale(reason: FlagReason): string {
  switch (reason.kind) {
    case "unsalvageable":
      return reason.rationale;
    case "max_rounds_exceeded":
      return reason.lastRationale;
    case "verifier_error":
      return `verifier_error: ${reason.error.code}${
        reason.error.code === "http_error" ? ` status=${reason.error.status}` : ""
      }${reason.error.code === "network" ? ` detail=${reason.error.detail}` : ""}`;
    case "corrector_error":
      return `corrector_error: ${reason.detail}`;
    default:
      return assertNever(reason);
  }
}

export async function processPromotionEvent(params: {
  workspaceDir: string;
  config: ResolvedDreamPoliceConfig;
  event: MemoryHostPromotionAppliedEvent;
  logger: PluginLogger;
  deps?: PipelineDeps;
}): Promise<PipelineResult> {
  const { workspaceDir, config, event, logger, deps = {} } = params;

  if (event.applied < config.scope.minApplied) {
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff: null,
      skippedReason: `applied (${event.applied}) below minApplied (${config.scope.minApplied})`,
    };
  }

  const provider = config.verifier.provider;
  if (!provider) {
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff: null,
      skippedReason: "verifier.provider is not fully configured",
    };
  }

  const diff = await buildPromotionDiff(workspaceDir, event, { readFile: deps.readFile });
  if (!diff) {
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff: null,
      skippedReason: "empty diff",
    };
  }

  const privacyDecision = applyPrivacyPolicy(diff, config.sensitivity);
  if (privacyDecision.kind === "skip") {
    logger.info(`dream-police: skipping verification (${privacyDecision.reason})`);
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff,
      skippedReason: privacyDecision.reason,
    };
  }

  if (privacyDecision.kind === "flag") {
    await writeAudit({
      workspaceDir,
      config,
      diff,
      rounds: 0,
      verdict: "needs_revision",
      issues: [],
      rationale: privacyDecision.reason,
      note: "flagged by privacy policy",
      deps,
    });
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff,
      skippedReason: privacyDecision.reason,
    };
  }

  const verifierDiff = privacyDecision.diff;
  const priorContext = await buildPriorContext(workspaceDir, verifierDiff, {
    readFile: deps.readFile,
    maxLines: config.verifier.priorContextLines,
  });

  const params_: TransitionParams = {
    maxRounds: config.retry.maxRounds,
    correctorEnabled: config.verifier.corrector !== null,
  };

  let state = transition(
    INITIAL_STATE,
    { kind: "batch_received", diff: verifierDiff },
    params_,
  );

  let lastCritique: VerifierCritique | undefined;

  while (!isTerminal(state)) {
    if (state.kind === "verifying") {
      const result = await verifyPromotion(
        {
          diff: state.diff,
          provider,
          priorContext,
          critiqueContext: lastCritique
            ? { lastCritique, roundsUsed: state.roundsUsed }
            : undefined,
        },
        {
          fetch: deps.verifier?.fetch,
          readEnv: deps.readEnv ?? deps.verifier?.readEnv,
        },
      );
      if (result.ok) {
        lastCritique = result.critique;
        state = transition(
          state,
          { kind: "critique_returned", critique: result.critique },
          params_,
        );
      } else {
        state = transition(state, { kind: "verifier_error", error: result.error }, params_);
      }
      continue;
    }

    if (state.kind === "correcting") {
      try {
        await applyCorrection({
          workspaceDir,
          diff: state.diff,
          critique: state.critique,
          deps: deps.corrector,
        });
        state = transition(state, { kind: "correction_applied" }, params_);
      } catch (err) {
        state = transition(
          state,
          {
            kind: "corrector_error",
            detail: err instanceof Error ? err.message : String(err),
          },
          params_,
        );
      }
      continue;
    }

    throw new Error(`pipeline: unexpected non-terminal state ${state.kind}`);
  }

  if (state.kind === "flagged") {
    await writeAudit({
      workspaceDir,
      config,
      diff: verifierDiff,
      rounds: state.roundsUsed,
      verdict: reasonToVerdict(state.reason),
      issues: lastCritique?.issues ?? [],
      rationale: reasonToRationale(state.reason),
      note: `state=${state.reason.kind}`,
      deps,
    });
  }

  return {
    finalState: state,
    roundsUsed: state.kind === "accepted" || state.kind === "flagged" ? state.roundsUsed : 0,
    diff: verifierDiff,
  };
}

async function writeAudit(params: {
  workspaceDir: string;
  config: ResolvedDreamPoliceConfig;
  diff: PromotionDiff;
  rounds: number;
  verdict: AuditEntry["finalVerdict"];
  issues: AuditEntry["issues"];
  rationale: string;
  note?: string;
  deps?: PipelineDeps;
}): Promise<void> {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    memoryPath: params.diff.memoryPath,
    candidateKeys: params.diff.candidates.map((c) => c.key).toSorted((a, b) => a.localeCompare(b)),
    roundsAttempted: params.rounds,
    finalVerdict: params.verdict,
    issues: params.issues,
    rationale: params.rationale,
    ...(params.note ? { note: params.note } : {}),
  };
  await appendAuditEntry({
    workspaceDir: params.workspaceDir,
    auditFile: params.config.auditFile,
    entry,
    deps: params.deps?.audit,
  });
}
