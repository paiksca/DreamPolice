import type { OpenClawPluginService, OpenClawPluginServiceContext } from "../api.js";
import {
  resolveDreamPoliceConfig,
  type DreamPolicePluginConfig,
  type ResolvedDreamPoliceConfig,
} from "./config.js";
import { processPromotionEvent } from "./pipeline.js";
import { JournalTailer } from "./tailer.js";

export type DreamPoliceServiceOptions = {
  pluginConfig?: DreamPolicePluginConfig;
};

export type DreamPoliceRuntimeStatus = {
  id: "dream-police";
  enabled: boolean;
  running: boolean;
  resolved: ResolvedDreamPoliceConfig | null;
  workspaceDir: string | null;
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

export function createDreamPoliceService(options: DreamPoliceServiceOptions = {}): ServiceHandle {
  let tailer: JournalTailer | null = null;
  let inflight: Promise<void> | null = null;
  const status: DreamPoliceRuntimeStatus = {
    id: "dream-police",
    enabled: false,
    running: false,
    resolved: null,
    workspaceDir: null,
  };

  async function start(ctx: OpenClawPluginServiceContext): Promise<void> {
    const resolved = resolveDreamPoliceConfig(options.pluginConfig);
    status.resolved = resolved;
    status.enabled = resolved.enabled;

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
    if (!resolved.verifier.provider) {
      ctx.logger.warn(
        "dream-police: verifier.provider is not fully configured; service will remain idle",
      );
      return;
    }

    const workspaceDir = ctx.workspaceDir;
    status.workspaceDir = workspaceDir;

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
              }`,
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
      `dream-police: started tailer pollInterval=${resolved.pollIntervalMs}ms maxRounds=${resolved.retry.maxRounds}`,
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
  }

  return {
    id: "dream-police",
    start,
    stop,
    getStatus: () => ({ ...status }),
  };
}
