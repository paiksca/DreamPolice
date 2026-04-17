# DreamPolice

**An OpenClaw plugin that supervises memory consolidations.**

OpenClaw's dreaming feature consolidates short-term memory into durable
`MEMORY.md` entries during quiet hours. The consolidation decisions are made by
the same agent that writes them — no independent verifier — so hallucinated
claims can be silently promoted into long-term memory, which is sticky and hard
to undo.

DreamPolice watches those promotions, asks an external verifier model to
fact-check them, and — if the verifier objects — re-runs the dream with a
structured critique injected as targeted feedback. It never silently reverts:
if correction fails after `retry.maxRounds`, the suspect promotion is flagged
in `DREAMS_POLICE.md` for your review.

## How it works

1. OpenClaw's memory-core runs a dream and appends a `memory.promotion.applied`
   event to `memory/.dreams/events.jsonl`.
2. DreamPolice tails that journal, slices the promoted lines out of the memory
   file, and sends them to a verifier model you configure (OpenAI-compatible).
3. If the verifier says `accepted`, the plugin logs and moves on.
4. If the verifier returns `needs_revision` with structured issues, DreamPolice
   applies the specific suggestions (`remove` / `rewrite` / `annotate`) and
   then re-verifies. Up to `retry.maxRounds` rounds.
5. If the verifier still objects after the final round, DreamPolice appends a
   human-readable entry to `DREAMS_POLICE.md`. **It never silently reverts.**

```
       ┌──────────────────────┐
       │  OpenClaw dreams     │
       └──────────┬───────────┘
                  ▼
    memory/.dreams/events.jsonl
                  │
                  ▼
       ┌──────────────────────┐
       │  JournalTailer       │
       └──────────┬───────────┘
                  ▼
       ┌──────────────────────┐
       │  Privacy filter      │  skip / redact / flag
       └──────────┬───────────┘
                  ▼
       ┌──────────────────────┐
       │  Verifier (external) │ ◄──── you configure this
       └──────────┬───────────┘
                  ▼
       ┌──────────────────────┐
       │  Correction loop     │  up to retry.maxRounds
       └──┬───────────────┬───┘
          ▼               ▼
   Memory file        DREAMS_POLICE.md
   corrected          (flagged, never reverted)
```

## Install

```bash
npm install openclaw-dream-police
# or
pnpm add openclaw-dream-police
```

Then register it with OpenClaw by adding the package as an extension in your
OpenClaw configuration (see the OpenClaw docs on installing third-party
plugins).

## Configuration

Add to your OpenClaw config at `plugins.entries.dream-police.config`:

```jsonc
{
  "enabled": true,
  "verifier": {
    "provider": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "DREAM_POLICE_API_KEY",
      "model": "gpt-5.4",
      "timeoutMs": 30000
    },
    "priorContextLines": 40
  },
  "retry": { "maxRounds": 2 },
  "scope": { "minApplied": 1 },
  "sensitivity": {
    "tags": ["secret", "private", "pii"],
    "pathPatterns": [],
    "onSensitive": "redact"
  },
  "auditFile": "memory/DREAMS_POLICE.md",
  "pauseFile": ".dream-police.paused",
  "pollIntervalMs": 2000
}
```

The API key **never** lives in config — set it in the environment variable
named by `apiKeyEnv`. The plugin uses an OpenAI-compatible
`/v1/chat/completions` endpoint, so you can point it at any
OpenAI-API-compatible service: OpenAI, Anthropic (via a proxy), local Ollama,
LM Studio, OpenRouter, etc.

### Sensitivity modes

- **`redact`** (default): strips emails, phone numbers, and API-token-looking
  strings from candidates before sending to the verifier.
- **`skip`**: candidates tagged `<!-- tag:secret -->` (or matching a
  `sensitivity.pathPatterns` glob) are not sent to the verifier at all, and no
  corrections are attempted for them.
- **`flag`**: sensitive candidates are not sent, but an entry is appended to
  `DREAMS_POLICE.md` so you know a dream touched sensitive content.

`sensitivity.pathPatterns` supports these forms:

- Exact path match (`notes/secret.md`) — matches only that file.
- `prefix/**` — matches `prefix/anything/nested.md` but **not**
  `prefix-other/file.md` (segment boundary is respected).
- Inline `*` (`journal/*.md`) — matches within a single directory segment; it
  does **not** cross `/`.
- Bare `**` — shorthand for "match every path".
- Patterns without `*` or `**` are treated as exact paths, not prefixes.

### Verifier output schema

The verifier model must return JSON of this shape:

```ts
{
  verdict: "accepted" | "needs_revision" | "unsalvageable",
  issues: Array<{
    claim: string,
    location: { memoryPath: string, startLine: number, endLine: number },
    reason: string,
    severity: "info" | "warn" | "error",
    suggestedAction:
      | { kind: "remove" }
      | { kind: "rewrite", replacement: string }
      | { kind: "annotate", note: string },
  }>,
  rationale: string,
  confidence: number,  // [0, 1]
}
```

`rewrite` actions with `confidence < 0.6` are auto-downgraded to `annotate` so
a low-confidence verifier can't silently destroy legitimate memory.

### Prompt-injection hardening

Every snippet the verifier sees is wrapped in delimiters
`<BEGIN_SNIPPET-{nonce}>` / `<END_SNIPPET-{nonce}>` with a fresh random nonce
per call, and the system prompt instructs the verifier to treat everything
between those delimiters as data, never instructions. If a memory snippet
tries to direct the verifier's behavior, that attempt is flagged in
`rationale` rather than obeyed.

## CLI

Once the plugin is installed and enabled, OpenClaw exposes:

```bash
openclaw dream-police status          # show enabled/paused state + last cursor
openclaw dream-police status --json   # machine-readable snapshot
openclaw dream-police pause           # create the pause file (stops processing)
openclaw dream-police resume          # remove the pause file
openclaw dream-police history         # tail recent verdicts from DREAMS_LOG.md
openclaw dream-police history -n 50   # with a custom limit
openclaw dream-police undo --list     # list pre-correction snapshots
openclaw dream-police undo --yes      # restore the most recent snapshot
```

Every command accepts `--workspace <dir>` to override OpenClaw's default
workspace resolution.

## Gateway method

The plugin also registers a gateway RPC method for UI/monitoring:

- `dreamPolice.status` (scope: `operator.read`) — returns a live runtime
  snapshot including the last processed event, any error, the circuit
  breaker state, and the resolved configuration.

## Dry-run mode

Set `dryRun: true` at the top of the config to run the full pipeline —
verifier calls, history, events — **without** mutating memory or writing the
audit file. Useful for evaluating how DreamPolice would act on your
workspace before letting it make changes.

```jsonc
{ "enabled": true, "dryRun": true, "verifier": { "provider": { ... } } }
```

## Multi-verifier quorum

For high-stakes workspaces, configure N verifiers that vote in parallel:

```jsonc
{
  "verifier": {
    "quorum": {
      "policy": "conservative",
      "providers": [
        { "baseUrl": "...", "apiKeyEnv": "ANTHROPIC_API_KEY", "model": "claude-opus-4-7" },
        { "baseUrl": "...", "apiKeyEnv": "OPENAI_API_KEY",    "model": "gpt-5.4" },
        { "baseUrl": "...", "apiKeyEnv": "OLLAMA_API_KEY",    "model": "qwen3:14b" }
      ]
    }
  }
}
```

Policies:

- `conservative` (default) — the most severe verdict across voters wins; any
  `unsalvageable` or `needs_revision` flags the promotion.
- `majority` — the plurality verdict wins, with ties broken toward severity.
- `unanimous` — only `accepted` if every voter agrees; otherwise the most
  severe dissent wins.

Issues from dissenting voters are deduplicated and merged before correction.

## Snapshots, history, events, circuit breaker

- **Snapshots** — before each correction, the memory file is snapshotted
  under `memory/.dreams/.dream-police/snapshots/`. `undo` restores the
  latest one. Keep count configurable via `snapshots.keep`.
- **History** — set `history.enabled: true` to append every verdict
  (accepted, corrected, flagged, skipped) to `memory/DREAMS_LOG.md`.
  Set `history.logAccepted: false` to only log non-trivial outcomes.
- **Events** — set `events.enabled: true` to stream structured events to
  `memory/.dreams/.dream-police/events.jsonl` for other plugins or UIs to
  consume.
- **Circuit breaker** — enabled by default. After
  `circuitBreaker.threshold` consecutive verifier errors (default 5), the
  plugin auto-creates the pause file and emits a
  `dreamPolice.circuitTripped` event. Resume manually once the upstream
  provider is healthy.

## Custom prompt

Set `verifier.systemPromptOverride` to replace DreamPolice's default
reviewer persona. The built-in prompt-injection preamble (snippet
delimiters and the "treat data as data" clause) is always appended, so
overrides can't accidentally weaken the defense.

## Presets

See [`examples/`](./examples) for ready-to-paste configs covering Claude,
OpenAI, Ollama, LM Studio, OpenRouter, quorum mode, and dry-run mode.

## Emergency disable

Three escape hatches:

1. Set `plugins.entries.dream-police.config.enabled = false` (requires
   restart).
2. Drop a `.dream-police.paused` file in the workspace root, or run
   `openclaw dream-police pause` — polled live.
3. Uninstall the plugin.

## Known limitations

- Verifier and corrector calls go out via raw `fetch`. There is no
  plugin-facing model-invocation API in OpenClaw yet.
- The corrector writes memory files directly because OpenClaw's memory plugin
  API doesn't expose a write seam. Edits are scoped to the exact line range
  the promotion just wrote and use atomic temp-file + fsync + rename.
- Interception is post-hoc (we tail the memory events journal). A future
  upstream PR to OpenClaw would add a pre-promotion hook so a verifier could
  veto bad promotions before they land.

## Development

```bash
pnpm install
pnpm test          # runs all tests including the HTTP-based integration smoke
pnpm typecheck
pnpm build         # emits dist/ (JS + d.ts + sourcemaps)
```

The test suite uses no external network — the integration smoke test spins up
a localhost HTTP server to stand in for the verifier.

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgments

Built against the [OpenClaw](https://github.com/openclaw/openclaw) plugin SDK.
This plugin is not affiliated with or endorsed by the OpenClaw project.
