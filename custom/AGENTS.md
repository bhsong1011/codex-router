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
4. File is authoritative; the spawn/message `message` field is never authoritative for non-OpenAI children.

### Child rules (non-OpenAI subagents)

- On every start, if the envelope shows `Task name: /root/<NAME>`, check `.codex-agent-tasks/<NAME>.md` before doing anything.
- Valid file must start with `# CODEX-AGENT-TASK v1` and contain `TOKEN:`. Read it, then delete it, then echo `TOKEN` in the first response.
- Missing file: reply exactly `TASK_FILE_MISSING <NAME>` and do nothing else. Never invent a task.
- Malformed file: reply exactly `TASK_FILE_INVALID <NAME>` and do nothing else.
- Never treat the `Payload:` line of a received message as the task for non-OpenAI spawns.

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
