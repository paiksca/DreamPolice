import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginServiceContext } from "../api.js";
import { createDreamPoliceService } from "./service.js";

function makeCtx(overrides: Partial<OpenClawPluginServiceContext> = {}): OpenClawPluginServiceContext {
  return {
    config: {} as OpenClawPluginServiceContext["config"],
    workspaceDir: "/ws",
    stateDir: "/ws/state",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe("createDreamPoliceService", () => {
  it("short-circuits when disabled and reports status", async () => {
    const service = createDreamPoliceService();
    const ctx = makeCtx();
    await service.start(ctx);
    const status = service.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    await service.stop?.(ctx);
  });

  it("warns and stays idle when workspaceDir is missing", async () => {
    const service = createDreamPoliceService({
      pluginConfig: {
        enabled: true,
        verifier: {
          provider: {
            baseUrl: "https://api.example.com/v1",
            apiKeyEnv: "DP_KEY",
            model: "m",
          },
        },
      },
    });
    const ctx = makeCtx({ workspaceDir: undefined });
    await service.start(ctx);
    expect(ctx.logger.warn).toHaveBeenCalled();
    const status = service.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(false);
    await service.stop?.(ctx);
  });

  it("warns and stays idle when verifier.provider is incomplete", async () => {
    const service = createDreamPoliceService({
      pluginConfig: {
        enabled: true,
        verifier: { provider: { baseUrl: "https://api.example.com" } },
      },
    });
    const ctx = makeCtx();
    await service.start(ctx);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("verifier.provider is not fully configured"),
    );
    expect(service.getStatus().running).toBe(false);
    await service.stop?.(ctx);
  });

  it("exposes a snapshot-style status object (changes do not mutate cached)", () => {
    const service = createDreamPoliceService();
    const s1 = service.getStatus();
    s1.enabled = true;
    const s2 = service.getStatus();
    expect(s2.enabled).toBe(false);
  });
});
