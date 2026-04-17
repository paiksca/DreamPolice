import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "../api.js";
import type { ResolvedDreamPoliceConfig } from "./config.js";
import { readRecentHistory } from "./history.js";
import { listSnapshots, parseSnapshotFilename, restoreSnapshot } from "./snapshot.js";
import { CURSOR_RELATIVE_PATH } from "./tailer.js";

type CliRegistrar = Parameters<OpenClawPluginApi["registerCli"]>[0];
type CliProgram = Parameters<CliRegistrar>[0]["program"];

type StatusOptions = { json?: boolean; workspace?: string };
type PauseOptions = { workspace?: string };
type ResumeOptions = { workspace?: string };
type HistoryOptions = { workspace?: string; limit?: string };
type UndoOptions = { workspace?: string; memoryPath?: string; list?: boolean; yes?: boolean };

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

/**
 * Resolve the workspace dir with this priority:
 *   1. explicit `--workspace` flag (wins if set)
 *   2. OpenClaw's CLI-context `workspaceDir` (correct when user invoked
 *      `openclaw` from a subdirectory)
 *   3. `process.cwd()` as a last resort.
 */
function resolveWorkspace(
  explicit: string | undefined,
  fromCli: string | undefined,
): string {
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }
  if (fromCli && fromCli.trim().length > 0) {
    return path.resolve(fromCli);
  }
  return process.cwd();
}

export async function cmdStatus(
  config: ResolvedDreamPoliceConfig,
  _appConfig: OpenClawConfig,
  options: StatusOptions,
  fromCli?: string,
): Promise<void> {
  const workspaceDir = resolveWorkspace(options.workspace, fromCli);
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

export async function cmdPause(
  config: ResolvedDreamPoliceConfig,
  _appConfig: OpenClawConfig,
  options: PauseOptions,
  fromCli?: string,
): Promise<void> {
  const workspaceDir = resolveWorkspace(options.workspace, fromCli);
  const pausePath = path.resolve(workspaceDir, config.pauseFile);
  await fs.mkdir(path.dirname(pausePath), { recursive: true });
  await fs.writeFile(pausePath, new Date().toISOString() + "\n", "utf8");
  process.stdout.write(`dream-police: paused (wrote ${pausePath})\n`);
}

export async function cmdResume(
  config: ResolvedDreamPoliceConfig,
  _appConfig: OpenClawConfig,
  options: ResumeOptions,
  fromCli?: string,
): Promise<void> {
  const workspaceDir = resolveWorkspace(options.workspace, fromCli);
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

export async function cmdHistory(
  config: ResolvedDreamPoliceConfig,
  _appConfig: OpenClawConfig,
  options: HistoryOptions,
  fromCli?: string,
): Promise<void> {
  const workspaceDir = resolveWorkspace(options.workspace, fromCli);
  const limit = options.limit ? Number.parseInt(options.limit, 10) : 20;
  const raw = await readRecentHistory({
    workspaceDir,
    historyFile: config.history.file,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
  });
  if (!raw) {
    process.stdout.write(
      `dream-police: no history at ${path.resolve(workspaceDir, config.history.file)} (history.enabled may be false)\n`,
    );
    return;
  }
  process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
}

export async function cmdUndo(
  config: ResolvedDreamPoliceConfig,
  _appConfig: OpenClawConfig,
  options: UndoOptions,
  fromCli?: string,
): Promise<void> {
  const workspaceDir = resolveWorkspace(options.workspace, fromCli);
  const snapshots = await listSnapshots({
    workspaceDir,
    snapshotDir: config.snapshots.dir,
    ...(options.memoryPath ? { memoryPath: options.memoryPath } : {}),
  });
  if (options.list) {
    if (snapshots.length === 0) {
      if (!config.snapshots.enabled) {
        process.stdout.write(
          "dream-police: no snapshots on disk (snapshots.enabled is false; enable it in config).\n",
        );
        return;
      }
      process.stdout.write(
        "dream-police: no snapshots on disk (none captured yet — run a correction first).\n",
      );
      return;
    }
    for (const s of snapshots) {
      const parsed = parseSnapshotFilename(s.filename);
      const label = parsed ? parsed.memoryPath : s.filename;
      process.stdout.write(`${new Date(s.mtimeMs).toISOString()}  ${label}  (${s.filename})\n`);
    }
    return;
  }
  if (snapshots.length === 0) {
    if (!config.snapshots.enabled) {
      process.stdout.write(
        "dream-police: nothing to undo — snapshots.enabled is false. Turn it on in config so corrections are snapshot-protected.\n",
      );
      return;
    }
    process.stdout.write(
      "dream-police: nothing to undo (no snapshots on disk yet). Run a correction first.\n",
    );
    return;
  }
  const latest = snapshots[0];
  const parsed = parseSnapshotFilename(latest.filename);
  const targetMemoryPath = options.memoryPath ?? parsed?.memoryPath ?? "memory/long-term.md";
  if (!options.yes) {
    process.stdout.write(
      `Would restore ${targetMemoryPath} from ${latest.filename}. Pass --yes to confirm.\n`,
    );
    return;
  }
  await restoreSnapshot({
    workspaceDir,
    snapshotAbsolutePath: latest.absolutePath,
    memoryPath: targetMemoryPath,
  });
  process.stdout.write(`dream-police: restored ${targetMemoryPath} from ${latest.filename}\n`);
}

export function registerDreamPoliceCli(
  program: CliProgram,
  config: ResolvedDreamPoliceConfig,
  appConfig: OpenClawConfig,
  cliWorkspaceDir?: string,
): void {
  const root = program
    .command("dream-police")
    .description("Inspect and control the DreamPolice supervisor");

  root
    .command("status")
    .description("Show whether dream-police is enabled, paused, and what it has processed")
    .option("--json", "emit JSON instead of human-readable text")
    .option("--workspace <dir>", "workspace directory (overrides OpenClaw default)")
    .action(async (options: StatusOptions) => {
      await cmdStatus(config, appConfig, options, cliWorkspaceDir);
    });

  root
    .command("pause")
    .description("Pause the supervisor by creating the pause file (polled live)")
    .option("--workspace <dir>", "workspace directory (overrides OpenClaw default)")
    .action(async (options: PauseOptions) => {
      await cmdPause(config, appConfig, options, cliWorkspaceDir);
    });

  root
    .command("resume")
    .description("Resume the supervisor by removing the pause file")
    .option("--workspace <dir>", "workspace directory (overrides OpenClaw default)")
    .action(async (options: ResumeOptions) => {
      await cmdResume(config, appConfig, options, cliWorkspaceDir);
    });

  root
    .command("history")
    .description("Show recent DreamPolice verdicts from DREAMS_LOG.md")
    .option("--workspace <dir>", "workspace directory (overrides OpenClaw default)")
    .option("-n, --limit <count>", "maximum entries to show", "20")
    .action(async (options: HistoryOptions) => {
      await cmdHistory(config, appConfig, options, cliWorkspaceDir);
    });

  root
    .command("undo")
    .description(
      "Restore the most recent pre-correction snapshot of the memory file (pass --yes to confirm)",
    )
    .option("--workspace <dir>", "workspace directory (overrides OpenClaw default)")
    .option("--memory-path <path>", "memory file to restore (default: inferred from snapshot)")
    .option("--list", "list snapshots instead of restoring")
    .option("-y, --yes", "actually perform the restore")
    .action(async (options: UndoOptions) => {
      await cmdUndo(config, appConfig, options, cliWorkspaceDir);
    });
}
