## Response style

Use laconic style by default:

- Be concise and precise; remove filler, pleasantries, repetition, and unnecessary hedging.
- Preserve technical substance, exact commands, code, paths, API names, and error strings.
- Prefer short paragraphs and compact lists. Fragments are acceptable when clear.
- Keep explanations readable; do not compress away important safety, ordering, or technical meaning.
- For security warnings, irreversible actions, and ambiguous multi-step procedures, use full clear sentences.
- If the user says "stop laconic" or "normal mode", use normal response style for the rest of that conversation.

## Subagent spawning

Always pass an explicit `agent_type` when calling `spawn_agent`. If `agent_type` is not explicitly set, do not call `spawn_agent`; ask the user instead.

## Session subagent routing

The user may define `SUBAGENT_ROUTE` in the session's initial prompt:

```text
SUBAGENT_ROUTE=<default | native-terra-high | personal-terra-high | personal-gpt6-luna-medium | personal-gpt6.1-sol-high | deepseek-flash-high>
```

Before the first subagent spawn:
- If `SUBAGENT_ROUTE` is defined, validate and bind it for every spawn in that session.
- If absent, ask the user once to select a route; recommend the configured `[agents]` default.
- Do not silently select an expensive native or personal OpenAI route.
- Record the selected provider, model, effort, and `agent_type` in the session.
- Use explicit model/effort routing on every spawn.

`default` resolves from `[agents]` in `config.toml`, currently
`deepseek/deepseek-v4.1-flash` / `high`.

`native-terra-high` resolves to `gpt-5.6-terra` / `high` with the normal
explicit task-role `agent_type`. It is selected only when the user explicitly
chooses that route.

`personal-terra-high` resolves to `chatgpt-login/gpt-5.6-terra` / `high` with
the normal explicit task-role `agent_type`. It is selected only when the user
explicitly chooses that route.

`personal-gpt6-luna-medium` resolves to `chatgpt-login/gpt-6-luna` / `medium`
with the normal explicit task-role `agent_type`. It is selected only when the
user explicitly chooses that route.

`personal-gpt6.1-sol-high` resolves to `chatgpt-login/gpt-6.1-sol` / `high`
with the normal explicit task-role `agent_type`. It is selected only when the
user explicitly chooses that route.

### DeepSeek Flash dispatch

When the selected route is `deepseek-flash-high` or `default`, spawn a native
DeepSeek child with exactly:

- `model: deepseek/deepseek-v4.1-flash`
- `reasoning_effort: high`
- `fork_turns: none`

Use the normal explicit `agent_type` for the intended role (`default`,
`worker`, `reviewer`, and so on). Native OA→DS task delivery and follow-up
messaging are verified; this is the only route that makes the DeepSeek child
visible in Codex's Subagents view.

The initial DeepSeek turn uses `high`, and thinking stays on for the rest of the
turn: the router carries each turn's reasoning summary back to the provider on
the following tool continuation, and records that same summary in the child's
own thread. Do not expose, invent, or transport private reasoning to work
around anything; if a continuation ever arrives without reasoning, report that
rather than reconstructing it by hand.

### DeepSeek progress contract

Give every DeepSeek child one bounded deliverable with explicit files, an
expected verification command, and a success criterion.

- At the first observable boundary before a long build, test, or research
  phase, emit a concise checkpoint in the child's own thread: files inspected,
  current hypothesis or finding, next command, and any blocker. Do not expose
  private reasoning. A child checkpoint or tool result is not necessarily
  mirrored into the parent's transcript.
- Do not spend a long opaque reasoning phase before the first observable
  inspection or action.
- A parent treats the UI thinking indicator as liveness only. Evidence of
  progress is a checkpoint, tool result, file diff, running process, test
  result, or final answer.
- In Codex's Subagents view, a child shown as active/running or showing tool
  activity is positive liveness evidence. The parent transcript is not a
  complete child-event stream. Never say that a child has no checkpoint, tool
  result, process, or reply unless the child's own thread was inspected and
  lacks it; parent-stream silence is only unobserved activity.
- `send_message` and `followup_task` queue an asynchronous instruction. Their
  empty tool output is not a child reply, and an active child may handle the
  instruction only after its current model/tool boundary. Do not classify that
  as delivery or liveness failure.
- Do not interrupt a running DeepSeek child solely because the parent has no
  visible checkpoint during its first five minutes. After that grace period,
  request a status checkpoint and wait a further five minutes. Interrupt only
  when the child thread itself has no checkpoint, tool result, file diff,
  running process, test result, or final answer for the full ten-minute
  window—or when the user sets a shorter deadline. If the child thread cannot
  be inspected, its liveness is unobserved, not failed; wait for its bounded
  deliverable instead of inferring failure from a blank message result.
- When the sidebar shows activity but the parent needs a result, use the normal
  wait mechanism for the bounded deliverable. Do not interrupt merely to force
  an interim reply.

### Provider routing

- OpenAI parent, OpenAI child: use `spawn_agent` normally with the real task in `message`. The encrypted channel is required. For `native-terra-high`, set `model: gpt-5.6-terra`; for `personal-terra-high`, set `model: chatgpt-login/gpt-5.6-terra`; set `reasoning_effort: high` for either route.
- For `personal-gpt6-luna-medium`, set `model: chatgpt-login/gpt-6-luna` and `reasoning_effort: medium` with the explicit task-role `agent_type`.
- For `personal-gpt6.1-sol-high`, set `model: chatgpt-login/gpt-6.1-sol` and `reasoning_effort: high` with the explicit task-role `agent_type`.
- OpenAI parent, DeepSeek Flash child: use `spawn_agent` normally with the real task in `message`, explicit task-role `agent_type`, `model: deepseek/deepseek-v4.1-flash`, `reasoning_effort: high`, and `fork_turns: none`. This native route makes DeepSeek visible as a child. If Codex explicitly rejects it, report the rejection; do not use task files or an MCP bridge.
- DeepSeek parent, DeepSeek Flash child: use the same direct native DeepSeek spawn and exact DS model/effort/fork settings as OpenAI→DeepSeek.
- DeepSeek parent, OpenAI child: use `spawn_agent` normally with the real task in `message`. It requires the user's explicit `native-terra-high` or `personal-terra-high` route selection and uses that route's model / `reasoning_effort: high`.
- Other provider combinations have no global fallback. Report the unsupported route instead of inventing a transport workaround.

Available `agent_type` values:

- `planner`
- `researcher`
- `reviewer`
- `test-runner`
- `explorer`
- `worker`
- `default`
This file sets global routing policy. `[agents]` defaults come from the active
Codex configuration; a project/worktree override must be configured explicitly.
