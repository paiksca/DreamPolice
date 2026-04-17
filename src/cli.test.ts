import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { cmdPause, cmdResume, cmdStatus } from "./cli.js";
import { resolveDreamPoliceConfig } from "./config.js";

const APP_CONFIG = {} as OpenClawConfig;
const CONFIG = resolveDreamPoliceConfig({
  enabled: true,
  verifier: {
    provider: {
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "DP_KEY",
      model: "gpt-5.4",
    },
  },
});

describe("dream-police CLI command handlers", () => {
  let tmp: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dream-police-cli-"));
    captured = "";
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("status prints a human-readable snapshot by default", async () => {
    await cmdStatus(CONFIG, APP_CONFIG, { workspace: tmp });
    expect(captured).toContain("dream-police: enabled");
    expect(captured).toContain(`workspace: ${tmp}`);
    expect(captured).toContain("paused:    no");
    expect(captured).toContain("cursor:    (not yet written");
  });

  it("status --json emits machine-readable output", async () => {
    await cmdStatus(CONFIG, APP_CONFIG, { workspace: tmp, json: true });
    const parsed = JSON.parse(captured) as { enabled: boolean; workspaceDir: string };
    expect(parsed.enabled).toBe(true);
    expect(parsed.workspaceDir).toBe(tmp);
  });

  it("pause writes the pause file and resume removes it", async () => {
    await cmdPause(CONFIG, APP_CONFIG, { workspace: tmp });
    const pausePath = path.join(tmp, CONFIG.pauseFile);
    expect(
      await fs
        .access(pausePath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    captured = "";
    await cmdResume(CONFIG, APP_CONFIG, { workspace: tmp });
    expect(captured).toContain("resumed");
    expect(
      await fs
        .access(pausePath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("resume is idempotent when the pause file is already absent", async () => {
    await cmdResume(CONFIG, APP_CONFIG, { workspace: tmp });
    expect(captured).toContain("already running");
  });
});
