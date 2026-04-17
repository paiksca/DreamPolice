# DreamPolice — Developer Notes

Repo layout:

- `index.ts` — plugin entry (`definePluginEntry` + `registerDreamPolice`).
- `api.ts` — re-exports of the OpenClaw SDK surfaces this plugin uses.
- `runtime-api.ts` — lazy runtime seam for tests.
- `openclaw.plugin.json` — plugin manifest consumed by OpenClaw at install time.
- `src/config.ts` — zod-validated plugin config + defaults.
- `src/types.ts` — shared discriminated unions.
- `src/state-machine.ts` — pure correction-loop reducer.
- `src/diff.ts` — slice promoted region from the memory file.
- `src/privacy.ts` — skip / redact / flag filter for sensitive content.
- `src/verifier.ts` — OpenAI-compatible fetch adapter + JSON schema parse.
- `src/corrector.ts` — apply `remove` / `rewrite` / `annotate` to the memory file.
- `src/audit.ts` — append-only writer for `DREAMS_POLICE.md`.
- `src/pipeline.ts` — orchestrates diff → privacy → verify → state-machine.
- `src/tailer.ts` — journal polling loop with a byte-offset cursor.
- `src/service.ts` — `OpenClawPluginService` wiring.
- `src/register.ts` — `register(api)` body.

Tests live next to sources as `*.test.ts`. The end-to-end smoke at
`src/smoke.integration.test.ts` spins up a real HTTP server on loopback and
exercises the full pipeline against a real temporary filesystem, so it's the
closest thing to a live run that doesn't require real API credentials.

## Boundary compromises (ported from the original in-monorepo version)

- OpenClaw does not expose a plugin-facing memory-write API. The corrector
  edits the memory markdown file directly, scoped to the candidate's line
  range, via atomic temp-file + rename.
- Memory events are consumed by tailing `memory/.dreams/events.jsonl`. There is
  no plugin hook for memory promotion yet; a pre-promotion hook would be a
  worthwhile upstream contribution.

## Releasing

Bump version in `package.json` and publish to npm. No additional build step
is required because the package ships TypeScript source — OpenClaw's runtime
resolves it via its own loader.
