import { describe, expect, it } from "vitest";
import { resolveDreamPoliceConfig } from "./config.js";

describe("resolveDreamPoliceConfig", () => {
  it("returns safe defaults for undefined input", () => {
    const cfg = resolveDreamPoliceConfig(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.verifier.provider).toBeNull();
    expect(cfg.verifier.corrector).toBeNull();
    expect(cfg.retry.maxRounds).toBe(2);
    expect(cfg.scope.phases).toEqual(["deep"]);
    expect(cfg.sensitivity.onSensitive).toBe("redact");
    expect(cfg.auditFile).toBe("memory/DREAMS_POLICE.md");
  });

  it("treats an incomplete provider block as no provider", () => {
    const cfg = resolveDreamPoliceConfig({
      enabled: true,
      verifier: { provider: { baseUrl: "https://api.example.com" } },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.verifier.provider).toBeNull();
  });

  it("resolves a fully configured provider and reuses it for the corrector by default", () => {
    const cfg = resolveDreamPoliceConfig({
      verifier: {
        provider: {
          baseUrl: "https://api.example.com/v1/",
          apiKeyEnv: "DP_KEY",
          model: "gpt-5.4",
        },
      },
    });
    expect(cfg.verifier.provider).toMatchObject({
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "DP_KEY",
      model: "gpt-5.4",
      timeoutMs: 30_000,
    });
    expect(cfg.verifier.corrector).toEqual(cfg.verifier.provider);
  });

  it("allows an explicit corrector distinct from the verifier", () => {
    const cfg = resolveDreamPoliceConfig({
      verifier: {
        provider: {
          baseUrl: "https://api.verifier",
          apiKeyEnv: "VERIFIER_KEY",
          model: "verifier-1",
        },
        corrector: {
          baseUrl: "https://api.corrector",
          apiKeyEnv: "CORRECTOR_KEY",
          model: "corrector-1",
        },
      },
    });
    expect(cfg.verifier.corrector?.apiKeyEnv).toBe("CORRECTOR_KEY");
    expect(cfg.verifier.corrector?.model).toBe("corrector-1");
  });

  it("null corrector disables corrections explicitly", () => {
    const cfg = resolveDreamPoliceConfig({
      verifier: {
        provider: {
          baseUrl: "https://api.example.com",
          apiKeyEnv: "KEY",
          model: "m",
        },
        corrector: null,
      },
    });
    expect(cfg.verifier.provider).not.toBeNull();
    expect(cfg.verifier.corrector).toBeNull();
  });

  it("accepts in-range retry counts", () => {
    const cfg = resolveDreamPoliceConfig({ retry: { maxRounds: 3 } });
    expect(cfg.retry.maxRounds).toBe(3);
  });
});
