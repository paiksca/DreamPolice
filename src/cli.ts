import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";
import { CURSOR_RELATIVE_PATH } from "./tailer.js";
import type { ResolvedDreamPoliceConfig } from "./config.js";

type CliRegistrar = Parameters<OpenClawPluginApi["registerCli"]>[0];
type CliProgram = Parameters<CliRegistrar>[0]["program"];

type StatusOptions = { json?: boolean };

type CursorShape = { offset: number; lastTimestamp: string };

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readCursor(absolutePath: string): Promise<CursorShape | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CursorShape>;
    if (typeof parsed.offset !== "number") return null;
    return {
      offset: parsed.offset,
      lastTimestamp: typeof parsed.lastTimestamp === "string" ? parsed.lastTimestamp : "",
    };
  } catch {
    return null;
  }
}

function resolveWorkspace(appConfig: OpenClawConfig): string {
  const fromConfig = (appConfig as { workspaceDir?: string }).workspaceDir;
  return fromConfig || process.cwd();
}

async function cmdStatus(
  config: ResolvedDreamPoliceConfig,
  appConfig: OpenClawConfig,
  options: StatusOptions,
): Promise<void> {
  const workspaceDir = resolveWorkspace(appConfig);
  const pausePath = path.resolve(workspaceDir, config.pauseFile);
  const cursorPath = path.resolve(workspaceDir, CURSOR_RELATIVE_PATH);
  const auditPath = path.isAbsolute(config.auditFile)
    ? config.auditFile
    : path.resolve(workspaceDir, config.auditFile);

  const paused = await fileExists(pausePath);
  const cursor = await readCursor(cursorPath);
  const auditExists = await fileExists(auditPath);

  const snapshot = {
    enabled: config.enabled,
    workspaceDir,
    verifier: config.verifier.provider
      ? {
          baseUrl: config.verifier.provider.baseUrl,
          model: config.verifier.provider.model,
          apiKeyEnv: config.verifier.provider.apiKeyEnv,
        }
      : null,
    paused,
    pauseFile: pausePath,
    cursor,
    auditFile: auditPath,
    auditExists,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return;
  }

  const lines: string[] = [];
  lines.push(`dream-police: ${snapshot.enabled ? "enabled" : "disabled"}`);
  lines.push(`  workspace: ${snapshot.workspaceDir}`);
  if (snapshot.verifier) {
    lines.push(
      `  verifier:  ${snapshot.verifier.baseUrl} [model=${snapshot.verifier.model} key=$${snapshot.verifier.apiKeyEnv}]`,
    );
  } else {
    lines.push("  verifier:  (not configured — set verifier.provider in config)");
  }
  lines.push(`  paused:    ${snapshot.paused ? "yes" : "no"} (${snapshot.pauseFile})`);
  if (snapshot.cursor) {
    lines.push(
      `  cursor:    offset=${snapshot.cursor.offset} lastTimestamp=${snapshot.cursor.lastTimestamp || "(none)"}`,
    );
  } else {
    lines.push("  cursor:    (not yet written — no events processed)");
  }
  lines.push(`  audit:     ${snapshot.auditExists ? "present" : "empty"} at ${snapshot.auditFile}`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdPause(
  config: ResolvedDreamPoliceConfig,
  appConfig: OpenClawConfig,
): Promise<void> {
  const workspaceDir = resolveWorkspace(appConfig);
  const pausePath = path.resolve(workspaceDir, config.pauseFile);
  await fs.mkdir(path.dirname(pausePath), { recursive: true });
  await fs.writeFile(pausePath, new Date().toISOString() + "\n", "utf8");
  process.stdout.write(`dream-police: paused (wrote ${pausePath})\n`);
}

async function cmdResume(
  config: ResolvedDreamPoliceConfig,
  appConfig: OpenClawConfig,
): Promise<void> {
  const workspaceDir = resolveWorkspace(appConfig);
  const pausePath = path.resolve(workspaceDir, config.pauseFile);
  try {
    await fs.unlink(pausePath);
    process.stdout.write(`dream-police: resumed (removed ${pausePath})\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stdout.write(`dream-police: already running (no ${pausePath})\n`);
      return;
    }
    throw err;
  }
}

export function registerDreamPoliceCli(
  program: CliProgram,
  config: ResolvedDreamPoliceConfig,
  appConfig: OpenClawConfig,
): void {
  const root = program
    .command("dream-police")
    .description("Inspect and control the DreamPolice supervisor");

  root
    .command("status")
    .description("Show whether dream-police is enabled, paused, and what it has processed")
    .option("--json", "emit JSON instead of human-readable text")
    .action(async (options: StatusOptions) => {
      await cmdStatus(config, appConfig, options);
    });

  root
    .command("pause")
    .description("Pause the supervisor by creating the pause file (polled live)")
    .action(async () => {
      await cmdPause(config, appConfig);
    });

  root
    .command("resume")
    .description("Resume the supervisor by removing the pause file")
    .action(async () => {
      await cmdResume(config, appConfig);
    });
}
