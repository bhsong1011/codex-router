# Notes and limitations

## Responses WebSocket rejection on the router edge (2026-10-08)

Symptom, twice: a turn fails with

```
Responses WebSocket messages must have type response.create.
```

First attempt at a fix was wrong and has been reverted. `[features]
responses_websockets = false` in `~/.codex/config.toml` is inert: the client
confirmed the flag off (`doctor` shows it absent from the 56 enabled features)
while still opening `codex_api::endpoint::responses_websocket`. The transport is
selected by provider capability, not that feature flag -- the documented key is
`model_providers.<id>.supports_websockets`
(developers.openai.com, config-file reference and the WebSocket-mode guide).

Second correction: this is our router, not OpenAI. `openai_base_url =
"http://127.0.0.1:4202/v1"` in `config.toml` reroutes the *native* provider
through the router, so even a `gpt-6-sol` turn lands on our edge -- the earlier
"native, therefore not ours" reasoning was wrong, as was reading an empty
`router.log` as proof, since in-band WS errors were never logged at all.

`src/responses-websocket.mjs` accepted exactly one client message type,
`response.create`. The 2026 protocol carries more: `response.steer` for
mid-turn input and `response.inject` for tool results
(developers.openai.com, Responses WebSocket reference). Anything else is
rejected with that 400 -- and the error envelope we send is keyed
`type, status, error`, matching what the thread recorded.

Change so far: a rejection now logs the offending type and keys, one line on the
error path only. Still to do once a rejection is captured: accept and forward the
types the client actually sends, or set
`model_providers.<id>.supports_websockets = false` to fall back to HTTP. The
output of the new log line decides which.

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

DeepSeek also gets a fork-local reasoning adapter. The chat-completions
translation can stream plaintext `reasoning_text`, and it can emit planning
text as an ordinary assistant message immediately after a `function_call`.
`src/deepseek-reasoning-collapse.mjs` converts both forms into Responses-style
collapsed reasoning summaries. It preserves the original opaque reasoning
content for DeepSeek follow-up requests. The next ordinary answer remains
visible; it is not reclassified.

Current Codex desktop already renders a reasoning item's `summary` as collapsed
thinking. No desktop renderer patch is required. Existing task history is
immutable; only new DeepSeek tasks show the corrected presentation.

Routed providers intentionally use HTTP Responses streaming
(`supports_websockets = false`). The router's WebSocket edge can lose a tool
result during continuation replay, producing LiteLLM's "No tool output found"
error followed by a client reconnect. Native OpenAI is unaffected.

Desktop-created tasks begin with a synthetic, call-id-less
`codex_app` `create_thread` or `send_message_to_thread` output containing a
`<codex_delegation>` envelope. It is not a valid tool-result history entry.
`normalizeRoutedInput` converts that envelope to normal user input before any
routed provider sees it. Real tool outputs retain their `call_id`.

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

## Marketplace upgrade staging leak

Found 2026-09-29. `$CODEX_HOME/.tmp/marketplaces/.staging` held 3,500
directories and 116G. Every one was a complete clone of the same repository
(`mksglu/context-mode`, 46M, clean tree, same commit) -- not partial work.

**Mechanism.** Reading account usage spawns a short-lived `codex app-server`.
Every app-server startup runs Codex's marketplace auto-upgrade on a detached
thread, which `git clone`s each configured Git marketplace into
`.staging/marketplace-upgrade-XXXXXX`. The router kills that app-server the
moment the account answer arrives -- about a second, via `killProcessTree()` in
`codex-account-usage.mjs` -- so the clone outlives its parent and finishes into
a directory nothing owns. Neither the git child is killed nor the temp-directory
destructor runs, and Codex has no equivalent of its own
`remove_stale_curated_repo_temp_dirs()` for this path, so the clone is permanent.
The upgrade never persists either: `config.toml` still recorded
`last_revision = 2dba0ff7` (Aug 31) against an upstream `c6477b6`, so the next
launch re-attempted the same upgrade and leaked again. Self-perpetuating.

**Why us.** The tray polls account usage every 30s for the island widget's
token and percent readout. Measured 6 app-server launches per minute, 3 orphans
per minute, ~8G/hour. The desktop app's own long-lived app-server also runs the
upgrade, but it survives, so its upgrades complete and nothing is orphaned.

Upstream tracking: openai/codex#47735 (root cause), #21005 (missing sweep),
#38770 (30s clone timeout), #45943 (212G on another machine), #34128 (annotated
tag loop). Unfixed in `0.155.0-alpha.16.3`.

**Fix (both landed here, neither upstream):**

- `account-usage-cache.mjs` -- `codex-router account` serves a reading cached
  for `ACCOUNT_USAGE_TTL_MS` (120s). The windows it paints are five hours and
  one week, so a cached answer is accurate, and it costs no process.
- `marketplace-staging-prune.mjs` -- removes `marketplace-*` entries older than
  `STALE_STAGING_MS` (10 min) at startup and on a ten-minute timer. The age
  floor is what makes it safe: the launcher dies in ~1s and its orphan finishes
  within a minute, so nothing that old is in flight. Non-`marketplace-*` entries
  are left alone.

**Verified.** 116G -> 1.5G on the initial sweep; `~/.codex` 120G -> 12G. Startup
sweep confirmed by planting a synthetic hour-old directory and restarting.
App-server launches 9 -> 2 per 90s, staging growth 3/min -> under 1/min.

**Deliberately not done.** A scratch `CODEX_HOME` for the account read would
remove the trigger outright (a home with no marketplaces has nothing to upgrade;
verified working), but it shares `auth.json` with the main home, so a token
refresh from the probe writes the file the app is using. Not shipped.
Reusing one long-lived app-server would also end the churn. Both are open.

### Long-lived account session (2026-09-29)

The cache and sweep above bounded the leak; they did not stop it. The trigger
is that a usage read spawns `codex app-server`, asks two questions, and kills it
about a second later -- while the marketplace upgrade that same startup began is
still running on a detached thread. The clone finishes into `.staging` and is
never reaped.

`src/codex-account-session.mjs` keeps one app-server for the lifetime of the
router service and reads `account/rateLimits/read` plus `account/usage/read` on
demand, serially, one request pair at a time. `startAccountUsageRefresh()` in
the same file republishes the result to `account-usage-cache.json` every 60
seconds; `control.mjs account` already reads that file, so the tray, the panel
and the CLI all take the published reading and spawn nothing. The CLI keeps its
own live spawn as a fallback for when the router is not running.

The session lives in `start.mjs` because that is the only long-lived process we
own -- `control.mjs` is one-shot. `stopChildren()` calls `stopAccountUsage()`,
so a router restart kills the Codex process it owns rather than orphaning it.
Failures back off 1s / 5s / 30s / 5min and are capped, so a Codex that cannot
start costs one attempt per interval instead of a spawn storm.

Verified: 7 unit tests against a stub app-server (reuse, timeout without
wedging, respawn after death, notification noise, publish-then-read, capped
backoff, stop kills the child), plus live observation -- the router holds
exactly one app-server, the cache refreshes every ~60s, a router restart reaps
the old child, and `.staging` stayed at zero across five minutes with the tray
polling.

Open: the tray reads account usage with `CODEX_HOME=~/.codex-personal`, which
resolves its own cache path (`~/.codex-personal/codex-router/`), so those reads
still miss the published cache and spawn. That home has no marketplaces
configured, so it strands nothing -- its staging directory does not exist -- but
it still spends a process every couple of minutes. Serving both homes from the
publisher, or keying the cache per home, would close it.