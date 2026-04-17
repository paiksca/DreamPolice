# Changelog

All notable changes to DreamPolice are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added — v0.2 feature push

- **Dry-run mode** (`dryRun: true`) — run the full verifier/correction
  pipeline without ever mutating memory or the audit file. History and
  events still record what would have happened.
- **History log** (`history.enabled: true`) — append every verdict
  (accepted, flagged, skipped, corrected) to `memory/DREAMS_LOG.md`.
  `openclaw dream-police history` tails it.
- **Snapshots + `undo`** (`snapshots.enabled: true`, default) — capture the
  memory file before each correction into
  `memory/.dreams/.dream-police/snapshots/`. `openclaw dream-police undo
  --list` shows them; `--yes` restores the most recent.
- **Circuit breaker** (`circuitBreaker.enabled: true`, default) — after N
  consecutive verifier errors (default 5) the plugin auto-creates the
  pause file and emits a `dreamPolice.circuitTripped` event so a runaway
  provider can't burn through API spend.
- **Plugin events** (`events.enabled: true`) — stream
  `dreamPolice.verified|corrected|flagged|skipped|circuitTripped` events to
  `memory/.dreams/.dream-police/events.jsonl` for other plugins/UIs.
- **Custom prompt override** (`verifier.systemPromptOverride`) — replace
  the default reviewer persona; the injection-defense preamble is always
  appended so overrides can't weaken the security contract.
- **Verifier quorum** (`verifier.quorum.providers`) — run multiple
  verifiers in parallel with `conservative`, `majority`, or `unanimous`
  policies. Dissenting issues are merged for the corrector.
- **Provider presets** — `examples/` directory with ready-to-paste configs
  for Claude, OpenAI, Ollama, LM Studio, OpenRouter, quorum mode, and
  dry-run mode.
- **Design doc**: `docs/shadow-dreamer.md` sketches what true collaborative
  multi-agent dreaming would need and why it belongs upstream in
  memory-core. Quorum covers the plugin-side half today.

CLI gained `history` and `undo` subcommands; tests now number 100 (up from
80).

### Added

- `openclaw dream-police status|pause|resume` CLI subcommands. The CLI reads
  `workspaceDir` from OpenClaw's CLI context when available, and accepts a
  `--workspace` flag to override.
- `dreamPolice.status` gateway RPC method (scope `operator.read`) returning a
  live runtime snapshot.
- Prompt-injection hardening: every verifier-visible snippet is wrapped in
  random-nonce delimiters and the system prompt treats the enclosed content
  strictly as data.
- `verifier.priorContextLines` config option to include up to N lines of the
  memory file preceding the candidate block in each verifier prompt.
- Proper `tsc` build emitting `dist/` with `.js`, `.d.ts`, and sourcemaps so
  the package is consumable from plain npm.
- Tests for `service.ts`, unsalvageable verdict in the pipeline, corrector
  `annotate` path, `JournalTailer` start/stop lifecycle, and privacy-glob
  segment boundaries.

### Fixed (triple-check pass)

- `openclaw.plugin.json` JSON schema agreed with the zod schema: removed
  `scope.phases` and `scope.perTypeOptOut` (now gone from both surfaces),
  added `verifier.priorContextLines`.
- Corrector now clamps edit ranges against the actual file length before
  overlap detection, preventing two edits whose ranges both extend past EOF
  from both appending.
- Verifier response parser handles the array-of-content-parts shape used by
  some OpenAI-compatible servers in addition to plain-string `content`.
- Bare `**` glob pattern in `sensitivity.pathPatterns` now matches every
  path (previously silently matched only single-segment paths).
- Tailer's `resolveDeps` is computed once in the constructor instead of on
  every getter access.

### Changed

- Journal tailer now reads fixed byte ranges with `fs.open` + `read`, so
  multibyte UTF-8 content no longer desyncs the cursor. Partial trailing
  lines are left for the next poll.
- Corrector threads the action kind (`remove` / `rewrite` / `annotate`)
  through the edit plan explicitly instead of inferring from a comment
  prefix, and atomic temp-file writes now `fsync` before `rename` and clean
  up on error.
- Corrector detects overlapping edit ranges and drops later overlaps rather
  than corrupting the file.
- Privacy path globs now respect directory-segment boundaries: `journal/secret/**`
  no longer matches `journal/secret-leak/...`, and inline `*` no longer
  crosses `/`.
- Phone-number redaction regex rewritten to avoid catastrophic backtracking
  on adversarial whitespace-heavy input.
- Verifier JSON schema now uses `z.strictObject` so unknown fields fail fast.
- `JournalTailer.start()` is idempotent; the scheduler re-checks the stopped
  flag before rescheduling to close a stop-vs-poll race.

### Removed

- `watchdog_fired` state event and `watchdogMs`/`startedAt` fields. The
  per-request `AbortController` in the verifier already handles timeouts.
- `scope.phases` and `scope.perTypeOptOut` config fields. Neither was
  consulted at runtime — promotion events do not carry a phase, and there
  was no source of "type" information.

## 0.1.0 — initial commit

- Tails OpenClaw's memory promotion journal.
- Sends promoted content to an external OpenAI-compatible verifier.
- Structured-critique correction loop with bounded retries, flag-only escape.
- Privacy filter (skip / redact / flag), `DREAMS_POLICE.md` audit log,
  `.dream-police.paused` pause file.
