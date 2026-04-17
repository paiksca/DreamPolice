import type { MemoryHostPromotionAppliedEvent, PluginLogger } from "../api.js";
import { appendAuditEntry } from "./audit.js";
import type { ResolvedDreamPoliceConfig } from "./config.js";
import { applyCorrection } from "./corrector.js";
import { buildPromotionDiff, buildPriorContext, type ReadFileFn } from "./diff.js";
import { emitDreamPoliceEvent, type DreamPoliceEvent, type EventEmitterDeps } from "./events.js";
import { appendHistoryEntry, type HistoryDeps, type HistoryOutcome } from "./history.js";
import { applyPrivacyPolicy } from "./privacy.js";
import { verifyWithQuorum } from "./quorum.js";
import { captureSnapshot, pruneSnapshots, type SnapshotDeps } from "./snapshot.js";
import { INITIAL_STATE, isTerminal, transition, type TransitionParams } from "./state-machine.js";
import type {
  AuditEntry,
  FlagReason,
  PromotionDiff,
  StateMachineState,
  VerifierCritique,
} from "./types.js";
import { verifyPromotion, type VerifierDeps, type VerifyResult } from "./verifier.js";

export type PipelineDeps = {
  readFile?: ReadFileFn;
  verifier?: VerifierDeps;
  corrector?: Parameters<typeof applyCorrection>[0]["deps"];
  audit?: Parameters<typeof appendAuditEntry>[0]["deps"];
  history?: HistoryDeps;
  events?: EventEmitterDeps;
  snapshot?: SnapshotDeps;
  readEnv?: (name: string) => string | undefined;
  now?: () => number;
  onVerifierSuccess?: () => void;
  onVerifierFailure?: () => Promise<void> | void;
};

export type PipelineResult = {
  finalState: StateMachineState;
  roundsUsed: number;
  diff: PromotionDiff | null;
  skippedReason?: string;
  dryRun: boolean;
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

async function dispatchVerify(
  params: {
    diff: PromotionDiff;
    config: ResolvedDreamPoliceConfig;
    priorContext: string;
    critiqueContext?: { lastCritique: VerifierCritique; roundsUsed: number };
  },
  deps: VerifierDeps,
): Promise<VerifyResult> {
  const quorum = params.config.verifier.quorum;
  const baseParams = {
    diff: params.diff,
    priorContext: params.priorContext,
    critiqueContext: params.critiqueContext,
    systemPromptOverride: params.config.verifier.systemPromptOverride,
  };
  if (quorum.providers.length > 0) {
    return verifyWithQuorum(
      { ...baseParams, providers: quorum.providers, policy: quorum.policy },
      deps,
    );
  }
  if (!params.config.verifier.provider) {
    return { ok: false, error: { code: "network", detail: "no verifier provider" } };
  }
  return verifyPromotion({ ...baseParams, provider: params.config.verifier.provider }, deps);
}

async function emitIfEnabled(
  config: ResolvedDreamPoliceConfig,
  workspaceDir: string,
  event: DreamPoliceEvent,
  deps: PipelineDeps,
): Promise<void> {
  if (!config.events.enabled) return;
  try {
    await emitDreamPoliceEvent({
      workspaceDir,
      relativeFile: config.events.file,
      event,
      deps: deps.events,
    });
  } catch {
    // Events are fire-and-forget telemetry; never let them block the pipeline.
  }
}

async function writeHistoryIfEnabled(
  config: ResolvedDreamPoliceConfig,
  workspaceDir: string,
  outcome: HistoryOutcome,
  diff: PromotionDiff,
  rounds: number,
  confidence: number | undefined,
  rationale: string | undefined,
  note: string | undefined,
  deps: PipelineDeps,
): Promise<void> {
  if (!config.history.enabled) return;
  if (outcome === "accepted" && !config.history.logAccepted) return;
  try {
    await appendHistoryEntry({
      workspaceDir,
      historyFile: config.history.file,
      entry: {
        timestamp: new Date().toISOString(),
        outcome,
        memoryPath: diff.memoryPath,
        candidateKeys: diff.candidates.map((c) => c.key).toSorted((a, b) => a.localeCompare(b)),
        rounds,
        ...(typeof confidence === "number" ? { confidence } : {}),
        ...(rationale ? { rationale } : {}),
        ...(note ? { note } : {}),
      },
      deps: deps.history,
    });
  } catch {
    // History is best-effort; never block the pipeline on log failures.
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
      dryRun: config.dryRun,
    };
  }

  const hasAnyProvider =
    config.verifier.provider !== null || config.verifier.quorum.providers.length > 0;
  if (!hasAnyProvider) {
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff: null,
      skippedReason: "verifier.provider is not fully configured",
      dryRun: config.dryRun,
    };
  }

  const diff = await buildPromotionDiff(workspaceDir, event, { readFile: deps.readFile });
  if (!diff) {
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff: null,
      skippedReason: "empty diff",
      dryRun: config.dryRun,
    };
  }

  const privacyDecision = applyPrivacyPolicy(diff, config.sensitivity);
  if (privacyDecision.kind === "skip") {
    logger.info(`dream-police: skipping verification (${privacyDecision.reason})`);
    await emitIfEnabled(
      config,
      workspaceDir,
      {
        type: "dreamPolice.skipped",
        timestamp: new Date().toISOString(),
        memoryPath: diff.memoryPath,
        reason: privacyDecision.reason,
      },
      deps,
    );
    await writeHistoryIfEnabled(
      config,
      workspaceDir,
      "skipped",
      diff,
      0,
      undefined,
      undefined,
      privacyDecision.reason,
      deps,
    );
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff,
      skippedReason: privacyDecision.reason,
      dryRun: config.dryRun,
    };
  }

  if (privacyDecision.kind === "flag") {
    if (!config.dryRun) {
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
    }
    await emitIfEnabled(
      config,
      workspaceDir,
      {
        type: "dreamPolice.flagged",
        timestamp: new Date().toISOString(),
        memoryPath: diff.memoryPath,
        candidateKeys: diff.candidates.map((c) => c.key),
        reason: "privacy-flag",
        rationale: privacyDecision.reason,
      },
      deps,
    );
    await writeHistoryIfEnabled(
      config,
      workspaceDir,
      "flagged",
      diff,
      0,
      undefined,
      privacyDecision.reason,
      "privacy-flag",
      deps,
    );
    return {
      finalState: INITIAL_STATE,
      roundsUsed: 0,
      diff,
      skippedReason: privacyDecision.reason,
      dryRun: config.dryRun,
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

  let state = transition(INITIAL_STATE, { kind: "batch_received", diff: verifierDiff }, params_);
  let lastCritique: VerifierCritique | undefined;
  let snapshotCaptured = false;

  while (!isTerminal(state)) {
    if (state.kind === "verifying") {
      const result = await dispatchVerify(
        {
          diff: state.diff,
          config,
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
        deps.onVerifierSuccess?.();
        await emitIfEnabled(
          config,
          workspaceDir,
          {
            type: "dreamPolice.verified",
            timestamp: new Date().toISOString(),
            memoryPath: verifierDiff.memoryPath,
            candidateKeys: verifierDiff.candidates.map((c) => c.key),
            verdict: result.critique.verdict,
            confidence: result.critique.confidence,
            rounds: state.roundsUsed,
          },
          deps,
        );
        state = transition(
          state,
          { kind: "critique_returned", critique: result.critique },
          params_,
        );
      } else {
        await deps.onVerifierFailure?.();
        state = transition(state, { kind: "verifier_error", error: result.error }, params_);
      }
      continue;
    }

    if (state.kind === "correcting") {
      if (config.dryRun) {
        // Dry-run: treat correction as a no-op so the loop terminates after
        // logging the critique. We transition as if correction was applied
        // and rely on the next verify to either accept or exhaust rounds.
        state = transition(state, { kind: "correction_applied" }, params_);
        continue;
      }
      if (!snapshotCaptured && config.snapshots.enabled) {
        try {
          await captureSnapshot({
            workspaceDir,
            memoryPath: verifierDiff.memoryPath,
            snapshotDir: config.snapshots.dir,
            deps: deps.snapshot,
          });
          snapshotCaptured = true;
          await pruneSnapshots({
            workspaceDir,
            snapshotDir: config.snapshots.dir,
            keep: config.snapshots.keep,
            memoryPath: verifierDiff.memoryPath,
            deps: deps.snapshot,
          }).catch(() => {
            // Prune failures are cosmetic.
          });
        } catch (err) {
          logger.warn(
            `dream-police: snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      try {
        const summary = await applyCorrection({
          workspaceDir,
          diff: state.diff,
          critique: state.critique,
          deps: deps.corrector,
        });
        await emitIfEnabled(
          config,
          workspaceDir,
          {
            type: "dreamPolice.corrected",
            timestamp: new Date().toISOString(),
            memoryPath: verifierDiff.memoryPath,
            candidateKeys: verifierDiff.candidates.map((c) => c.key),
            round: state.roundsUsed + 1,
            appliedEditCount: summary.appliedEditCount,
          },
          deps,
        );
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
    if (!config.dryRun) {
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
    await emitIfEnabled(
      config,
      workspaceDir,
      {
        type: "dreamPolice.flagged",
        timestamp: new Date().toISOString(),
        memoryPath: verifierDiff.memoryPath,
        candidateKeys: verifierDiff.candidates.map((c) => c.key),
        reason: state.reason.kind,
        rationale: reasonToRationale(state.reason),
      },
      deps,
    );
    await writeHistoryIfEnabled(
      config,
      workspaceDir,
      "flagged",
      verifierDiff,
      state.roundsUsed,
      lastCritique?.confidence,
      reasonToRationale(state.reason),
      config.dryRun
        ? `dry-run; state=${state.reason.kind}`
        : `state=${state.reason.kind}`,
      deps,
    );
  } else if (state.kind === "accepted") {
    const outcome: HistoryOutcome =
      state.roundsUsed === 0 ? "accepted" : "accepted-after-correction";
    await writeHistoryIfEnabled(
      config,
      workspaceDir,
      outcome,
      verifierDiff,
      state.roundsUsed,
      lastCritique?.confidence,
      lastCritique?.rationale,
      config.dryRun ? "dry-run" : undefined,
      deps,
    );
  }

  return {
    finalState: state,
    roundsUsed: state.kind === "accepted" || state.kind === "flagged" ? state.roundsUsed : 0,
    diff: verifierDiff,
    dryRun: config.dryRun,
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
