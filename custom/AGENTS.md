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
SUBAGENT_ROUTE=<default | native-terra-high | personal-terra-high | deepseek-flash-high>
```

Before the first subagent spawn:
- If `SUBAGENT_ROUTE` is defined, validate and bind it for every spawn in that session.
- If absent, ask the user once to select a route; recommend the configured `[agents]` default.
- Do not silently select an expensive native or personal OpenAI route.
- Record the selected provider, model, effort, and `agent_type` in the session.
- Use explicit model/effort routing on every spawn.

`default` resolves from `[agents]` in `config.toml`, currently
`deepseek/deepseek-v4-flash` / `high`.

### DeepSeek Flash dispatch

When the selected route is `deepseek-flash-high` or `default`, every spawned
DeepSeek child must use exactly:

- `agent_type: router_deepseek_deepseek_v4_flash`
- `model: deepseek/deepseek-v4-flash`
- `reasoning_effort: high`
- `fork_turns: none`

Do not use `worker`, `reviewer`, `default`, or an inherited agent type for a
DeepSeek child. Those are task roles, not DeepSeek transport selection: put
the intended role and its requirements in the task text instead. This avoids
the Codex generic-agent path that can create a DeepSeek child without
delivering its task payload.

### DeepSeek progress contract

Give every DeepSeek child one bounded deliverable with explicit files, an
expected verification command, and a success criterion.

- Before a build, test, or research phase likely to take more than a few
  minutes, emit a concise visible checkpoint: files inspected, current
  hypothesis or finding, next command, and any blocker. Do not expose private
  reasoning.
- Do not spend a long opaque reasoning phase before the first observable
  inspection or action.
- A parent treats the UI thinking indicator as liveness only. Evidence of
  progress is a checkpoint, tool result, file diff, running process, test
  result, or final answer.
- If a child has no checkpoint after a short bounded wait, request a status
  checkpoint. For OpenAI-parent to DeepSeek-child communication, recreate the
  child task file with a new token first; for DeepSeek-parent children, send
  the request as the normal task message.

### Provider routing

- OpenAI parent, OpenAI/chatgpt-login child: use `spawn_agent` normally with the real task in `message`. The encrypted channel is required.
- OpenAI parent, non-OpenAI child: use the **task-file protocol** below. Never put task text in `message`.
- DeepSeek parent, any child: use `spawn_agent` normally with the real task in `message`; plaintext delivery works. Do not use the task-file protocol.

### Task-file protocol (OpenAI parent -> non-OpenAI child)

1. Generate a unique task name with `exec_command` (TASK_TEXT is the full task, single line, no unescaped quotes):
   ```bash
   mkdir -p .codex-agent-tasks
   NAME=t$(date +%s%3N)_$(openssl rand -hex 4)
   printf '# CODEX-AGENT-TASK v1\nTOKEN: %s\nTASK:\n%s\n' "$NAME" "TASK_TEXT_HERE" > ".codex-agent-tasks/${NAME}.md"
   echo "$NAME"
   ```
2. Call `spawn_agent` with `task_name: <NAME>`, `message: "READ_TASK_FILE"`, `fork_turns: "none"`, and the non-OpenAI `agent_type`.
3. After the child finishes, verify its first response contains the exact `TOKEN` from the file. If not, rewrite the file and retry via `send_message`/`followup_task` with `target: <NAME>` and `message: "READ_TASK_FILE"`.
4. In task-file mode, the file is authoritative; the spawn/message `message` field is never authoritative.
5. Every later `followup_task` in task-file mode is a new task. Before sending `READ_TASK_FILE`, recreate `.codex-agent-tasks/<existing-child-task-name>.md` with the complete follow-up task and a new token; the child deletes its file after each task. Never send `READ_TASK_FILE` to an existing child without a fresh file, and verify its next response contains the new token.

### Child task delivery rules (non-OpenAI subagents)

Use task-file mode only when the received task payload is exactly
`READ_TASK_FILE`.

- In task-file mode, if the envelope shows `Task name: /root/<NAME>`, read `.codex-agent-tasks/<NAME>.md` before doing anything. A valid file starts with `# CODEX-AGENT-TASK v1` and contains `TOKEN:`. Read it, then delete only your own `<NAME>.md`; never remove the `.codex-agent-tasks` directory.
- In task-file mode, every response to the parent, especially the final answer, must begin with the exact line `TOKEN <NAME>` followed by the routing attestation. Never end a turn with a summary that omits it.
- In task-file mode, a missing file requires exactly `TASK_FILE_MISSING <NAME>`; a malformed file requires exactly `TASK_FILE_INVALID <NAME>`. Do nothing else in either case.
- Otherwise use the received task payload normally. It is the authoritative task for a DeepSeek-parent child; do not look for a task file and do not emit a task-file token attestation.

Available `agent_type` values:

- `planner`
- `researcher`
- `reviewer`
- `test-runner`
- `explorer`
- `worker`
- `default`
- `router_chatgpt_login_gpt_5_6_luna`
- `router_chatgpt_login_gpt_5_6_sol`
- `router_chatgpt_login_gpt_5_6_terra`
- `router_deepseek_deepseek_v4_flash`
- `router_deepseek_deepseek_v4_pro`

Model preference is set per worktree, not globally.
