import type { OpenClawPluginService, OpenClawPluginServiceContext } from "../api.js";
import { resolveDreamPoliceConfig, type DreamPolicePluginConfig } from "./config.js";
import { processPromotionEvent } from "./pipeline.js";
import { JournalTailer } from "./tailer.js";

export type DreamPoliceServiceOptions = {
  pluginConfig?: DreamPolicePluginConfig;
};

export function createDreamPoliceService(
  options: DreamPoliceServiceOptions = {},
): OpenClawPluginService {
  let tailer: JournalTailer | null = null;
  let inflight: Promise<void> | null = null;

  return {
    id: "dream-police",
    async start(ctx: OpenClawPluginServiceContext) {
      const resolved = resolveDreamPoliceConfig(options.pluginConfig);
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
              ctx.logger.info(
                `dream-police: finished event timestamp=${event.timestamp} state=${result.finalState.kind} rounds=${result.roundsUsed}${
                  result.skippedReason ? ` skipped=${result.skippedReason}` : ""
                }`,
              );
            },
            (err) => {
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
      ctx.logger.info(
        `dream-police: started tailer pollInterval=${resolved.pollIntervalMs}ms maxRounds=${resolved.retry.maxRounds}`,
      );
    },
    async stop() {
      if (tailer) {
        await tailer.stop();
        tailer = null;
      }
      if (inflight) {
        await inflight.catch(() => {});
      }
    },
  };
}
