# Codex Router customization

Personal fork of `duolahypercho/codex-router` with multi-provider support for
Personal ChatGPT login and cross-provider subagent conventions, rebased onto
upstream `main` (`43deff5`).

## What is customized

- `chatgpt-login` provider: OAuth refresh and `ChatGPT-Account-Id` routing for
  accounts that only expose Codex through ChatGPT login, not the API.
- `deepseek-reasoning-collapse.mjs`: rewrites DeepSeek's plaintext
  `reasoning_text` and strips all reasoning stream events, so the desktop never
  shows an internal-thinking block for DeepSeek.
- Direct DeepSeek models, interrupted tool-call repair, and encrypted-content
  sanitization now ship upstream; the older fork-local versions were dropped
  after replaying the failure against upstream (see `custom/NOTES.md`).
- Routed models advertise `multi_agent_version: "v2"` through upstream's
  catalog so v2 sessions can spawn them.

## Cross-provider subagent matrix

| route | delivery | status |
| --- | --- | --- |
| oa to oa | encrypted agent message | works |
| oa to non-oa | task-file protocol | works (backend-locked, see NOTES) |
| ds to ds | plaintext agent message | works |
| ds to oa | plaintext agent message | works |

The task-file protocol is defined in `custom/AGENTS.md`, which is the canonical
copy of the global `~/.codex/AGENTS.md` rules.

## New machine installation

1. Install the Codex desktop app normally.
2. Clone this fork: `git clone https://github.com/bhsong1011/codex-router.git`
3. `cd codex-router && ./custom/apply-patches.sh --router`
4. Clone and build the patched Codex CLI (see `custom/apply-codex.sh` in the
   codex fork, or `bhsong1011/codex` branch `custom-v0.151.0`).
5. Log in for the Personal provider:
   `mkdir -p ~/.codex-personal && CODEX_HOME=~/.codex-personal codex login`
6. Enable providers and restart:
   `bin/model-router codex provider-selection` then `bin/model-router codex doctor`
7. Fully restart Codex desktop.

## Maintenance

On upstream router updates, rebase this fork, regenerate
`custom/router.patch`, and update `custom/NOTES.md`.

The `custom/` folder is entirely local; the underlying provider, model, and
router code is upstream with local additions.
