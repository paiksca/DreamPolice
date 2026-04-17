# DreamPolice config presets

These JSON files are ready-to-copy snippets for the `plugins.entries.dream-police.config`
section of your OpenClaw config (`~/.openclaw/openclaw.json` for global, or
`openclaw.config.json` in a workspace).

| Preset | Use case |
|---|---|
| [`anthropic-claude.json`](./anthropic-claude.json) | Claude via Anthropic's OpenAI-compatible proxy |
| [`openai.json`](./openai.json) | Vanilla OpenAI (GPT-5.4) |
| [`ollama.json`](./ollama.json) | Fully local via Ollama (`qwen3:14b` or similar) |
| [`lm-studio.json`](./lm-studio.json) | Fully local via LM Studio |
| [`openrouter.json`](./openrouter.json) | OpenRouter — one key, many models |
| [`quorum.json`](./quorum.json) | Multi-verifier quorum for high-stakes workspaces |
| [`dry-run.json`](./dry-run.json) | Evaluation mode: log verdicts, never mutate memory |

Each preset shows the minimum shape; consult `../README.md` for the full
config surface (`sensitivity`, `snapshots`, `circuitBreaker`, `history`,
`events`, …).

API keys never live in config — set the env var named by `apiKeyEnv` in the
shell that starts OpenClaw (or in your shell profile for long-running
gateways).
