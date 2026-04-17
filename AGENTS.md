# DreamPolice — Developer Notes

Repo layout:

- `index.ts` — plugin entry (`definePluginEntry` + `registerDreamPolice`).
- `api.ts` — re-exports of the OpenClaw SDK surfaces this plugin uses.
- `runtime-api.ts` — lazy runtime seam for tests.
- `openclaw.plugin.json` — plugin manifest consumed by OpenClaw at install
  time.
- `src/config.ts` — zod-validated plugin config + defaults.
- `src/types.ts` — shared discriminated unions.
- `src/state-machine.ts` — pure correction-loop reducer.
- `src/diff.ts` — slice promoted region and prior context from the memory
  file.
- `src/privacy.ts` — skip / redact / flag filter for sensitive content.
- `src/verifier.ts` — OpenAI-compatible fetch adapter + JSON schema parse +
  prompt-injection delimiters.
- `src/corrector.ts` — apply `remove` / `rewrite` / `annotate` to the memory
  file with overlap detection and fsync'd temp+rename.
- `src/audit.ts` — append-only writer for `DREAMS_POLICE.md`.
- `src/pipeline.ts` — orchestrates diff → privacy → verify → state-machine.
- `src/tailer.ts` — journal polling loop with a byte-offset cursor.
- `src/service.ts` — `OpenClawPluginService` wiring + runtime status snapshot.
- `src/cli.ts` — commander-based `openclaw dream-police ...` commands.
- `src/gateway.ts` — `dreamPolice.status` gateway RPC handler.
- `src/register.ts` — `register(api)` body.

Tests live next to sources as `*.test.ts`. The end-to-end smoke at
`src/smoke.integration.test.ts` spins up a real HTTP server on loopback and
exercises the full pipeline against a real temporary filesystem, so it's the
closest thing to a live run that doesn't require real API credentials.

## Boundary compromises

- OpenClaw does not expose a plugin-facing memory-write API. The corrector
  edits the memory markdown file directly, scoped to the candidate's line
  range, via atomic temp+fsync+rename.
- Memory events are consumed by tailing `memory/.dreams/events.jsonl` (same
  seam as `memory-wiki`). There is no plugin hook for memory promotion yet; a
  pre-promotion hook would be a worthwhile upstream contribution.

## Scripts

- `pnpm test` — runs unit + integration tests. No network required.
- `pnpm typecheck` — strict `tsc --noEmit` pass.
- `pnpm build` — emits JS + `.d.ts` + sourcemaps to `dist/` via
  `tsconfig.build.json`.
- `pnpm clean` — removes `dist/`.
- `pnpm prepublishOnly` — clean + build + test before publish.

## Releasing

Bump `version` in `package.json`, update the Unreleased section of
`CHANGELOG.md`, ensure `pnpm prepublishOnly` is green, then `npm publish`.
