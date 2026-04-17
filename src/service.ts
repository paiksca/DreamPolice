import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "../api.js";
import { CircuitBreaker } from "./circuit.js";
import {
  resolveDreamPoliceConfig,
  type DreamPolicePluginConfig,
  type ResolvedDreamPoliceConfig,
} from "./config.js";
import { emitDreamPoliceEvent } from "./events.js";
import { processPromotionEvent } from "./pipeline.js";
import { JournalTailer } from "./tailer.js";

export type DreamPoliceServiceOptions = {
  pluginConfig?: DreamPolicePluginConfig;
};

export type DreamPoliceRuntimeStatus = {
  id: "dream-police";
  enabled: boolean;
  running: boolean;
  dryRun: boolean;
  resolved: ResolvedDreamPoliceConfig | null;
  workspaceDir: string | null;
  consecutiveVerifierErrors: number;
  circuitTripped: boolean;
  lastEvent?: {
    timestamp: string;
    state: string;
    rounds: number;
    skippedReason?: string;
    at: string;
  };
  lastError?: {
    message: string;
    at: string;
  };
};

type ServiceHandle = OpenClawPluginService & {
  getStatus(): DreamPoliceRuntimeStatus;
};

async function createPauseFile(workspaceDir: string, pauseFile: string): Promise<void> {
  const pausePath = path.resolve(workspaceDir, pauseFile);
  await fs.mkdir(path.dirname(pausePath), { recursive: true });
  await fs.writeFile(
    pausePath,
    `${new Date().toISOString()}\ntripped by dream-police circuit breaker\n`,
    "utf8",
  );
}

export function createDreamPoliceService(options: DreamPoliceServiceOptions = {}): ServiceHandle {
  let tailer: JournalTailer | null = null;
  let inflight: Promise<void> | null = null;
  let breaker: CircuitBreaker | null = null;
  const status: DreamPoliceRuntimeStatus = {
    id: "dream-police",
    enabled: false,
    running: false,
    dryRun: false,
    resolved: null,
    workspaceDir: null,
    consecutiveVerifierErrors: 0,
    circuitTripped: false,
  };

  async function start(ctx: OpenClawPluginServiceContext): Promise<void> {
    const resolved = resolveDreamPoliceConfig(options.pluginConfig);
    status.resolved = resolved;
    status.enabled = resolved.enabled;
    status.dryRun = resolved.dryRun;

    if (!resolved.enabled) {
      ctx.logger.debug?.("dream-police: service disabled; skipping start");
      return;
    }
    if (!ctx.workspaceDir) {
      ctx.logger.warn(
        "dream-police: no workspaceDir in service context; cannot tail memory journal",
      );
      return;
    }
    const hasProvider =
      resolved.verifier.provider !== null || resolved.verifier.quorum.providers.length > 0;
    if (!hasProvider) {
      ctx.logger.warn(
        "dream-police: verifier.provider is not fully configured; service will remain idle",
      );
      return;
    }

    const workspaceDir = ctx.workspaceDir;
    status.workspaceDir = workspaceDir;

    breaker = new CircuitBreaker({
      enabled: resolved.circuitBreaker.enabled,
      threshold: resolved.circuitBreaker.threshold,
      onTrip: async (info) => {
        status.circuitTripped = true;
        ctx.logger.warn(
          `dream-police: circuit breaker tripped after ${info.consecutiveErrors} errors; creating pause file`,
        );
        try {
          await createPauseFile(workspaceDir, resolved.pauseFile);
        } catch (err) {
          ctx.logger.error(
            `dream-police: failed to create pause file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (resolved.events.enabled) {
          try {
            await emitDreamPoliceEvent({
              workspaceDir,
              relativeFile: resolved.events.file,
              event: {
                type: "dreamPolice.circuitTripped",
                timestamp: new Date().toISOString(),
                consecutiveErrors: info.consecutiveErrors,
                threshold: info.threshold,
              },
            });
          } catch {
            // Best-effort telemetry.
          }
        }
      },
    });

    tailer = new JournalTailer({
      workspaceDir,
      pollIntervalMs: resolved.pollIntervalMs,
      pauseFile: resolved.pauseFile,
      logger: ctx.logger,
      handler: async (event) => {
        inflight = processPromotionEvent({
          workspaceDir,
          config: resolved,
          event,
          logger: ctx.logger,
          deps: {
            onVerifierSuccess: () => {
              breaker?.recordSuccess();
              status.consecutiveVerifierErrors = breaker?.failureCount ?? 0;
            },
            onVerifierFailure: async () => {
              await breaker?.recordFailure();
              status.consecutiveVerifierErrors = breaker?.failureCount ?? 0;
            },
          },
        }).then(
          (result) => {
            status.lastEvent = {
              timestamp: event.timestamp,
              state: result.finalState.kind,
              rounds: result.roundsUsed,
              ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
              at: new Date().toISOString(),
            };
            ctx.logger.info(
              `dream-police: finished event timestamp=${event.timestamp} state=${result.finalState.kind} rounds=${result.roundsUsed}${
                result.skippedReason ? ` skipped=${result.skippedReason}` : ""
              }${result.dryRun ? " (dry-run)" : ""}`,
            );
          },
          (err) => {
            status.lastError = {
              message: err instanceof Error ? err.message : String(err),
              at: new Date().toISOString(),
            };
            ctx.logger.error(
              `dream-police: pipeline failed for event timestamp=${event.timestamp}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          },
        );
        await inflight;
      },
    });
    await tailer.start();
    status.running = true;
    ctx.logger.info(
      `dream-police: started tailer pollInterval=${resolved.pollIntervalMs}ms maxRounds=${resolved.retry.maxRounds}${resolved.dryRun ? " (dry-run)" : ""}${resolved.verifier.quorum.providers.length > 0 ? ` quorum=${resolved.verifier.quorum.providers.length}` : ""}`,
    );
  }

  async function stop(): Promise<void> {
    status.running = false;
    if (tailer) {
      await tailer.stop();
      tailer = null;
    }
    if (inflight) {
      await inflight.catch(() => {});
    }
    breaker?.reset();
    breaker = null;
    status.consecutiveVerifierErrors = 0;
    status.circuitTripped = false;
  }

  return {
    id: "dream-police",
    start,
    stop,
    getStatus: () => ({ ...status }),
  };
}
