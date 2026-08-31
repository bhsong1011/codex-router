# Notes and limitations

## Baselines

- Router fork base: `duolahypercho/codex-router` commit `43deff5`.
- Codex core patch base: `openai/codex` tag `rust-v0.151.0`.
- Patched Codex CLI fork: `bhsong1011/codex` branch `custom-v0.151.0`.

## What upstream now covers

- Direct DeepSeek provider config (`config/deepseek/`) and request profiles.
- `normalizeRoutedAgentInput`: encrypted agent payloads are rewritten to
  plaintext for routed models.
- `deepseek-tool-message-compat.mjs`: streaming tool-delta repair.
- Chat-completions orphan tool repair (`ensureToolResultsForCalls` and the
  `http-utils.mjs` re-seating pass). Replaying the interrupted
  `wait_agent` history that motivated the old `f07b0a5` fix now succeeds, so
  that Responses-input pairing was not ported.

The remaining fork-local router change is the `chatgpt-login` Personal
provider: token refresh from `~/.codex-personal/auth.json` and native backend
routing with `ChatGPT-Account-Id`.

## Why v2 and not v1

OpenAI `gpt-5.6` models run the v2 multi-agent runtime natively. V2 marks
`spawn_agent`/`send_message`/`followup_task` message fields as encrypted and
the backend owns the reserved `collaboration` schema. Local schema changes are
rejected with "reserved for use by this model".

## oa to non-oa limitation

The OpenAI backend encrypts the spawn message before local Codex sees it and
never sends the plaintext marker (`encrypted_function_args: []`) for cross-
provider targets. Client-side plaintext delivery for an OpenAI parent to a
non-OpenAI child is therefore impossible; the task-file protocol is the
workaround.

Upstream tracking:

- https://github.com/openai/codex/issues/36376
- https://github.com/openai/codex/pull/35845
- https://github.com/openai/codex/issues/33551
- https://github.com/openai/codex/issues/36586
- https://github.com/openai/codex/issues/34833

## Build constraints

- Scripts target Linux x86_64 first.
- `cargo build --release --bin codex` takes about 12-15 minutes and roughly
  9 GB of RAM.
- Do not commit the built binary (~1.4 GB). Rebuild per machine or ship the
  binary out of band.
- Verification is behavior-based (doctor + spawn matrix), not binary sha.
