// A fake `codex app-server` for the account-session tests: the same
// newline-delimited JSON-RPC the real one speaks, plus knobs for the failure
// modes the session has to survive.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

if (process.env.STUB_SPAWN_LOG) appendFileSync(process.env.STUB_SPAWN_LOG, `${process.pid}\n`);

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    write({ id: message.id, result: {} });
    if (process.env.STUB_DIE_AFTER_INIT === "1") process.exit(0);
    // An unprompted notification, which the client must not mistake for a reply.
    write({ method: "session/notification", params: { note: "noise" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "account/rateLimits/read") {
    if (process.env.STUB_HANG_LIMITS === "1") return;
    write({
      id: message.id,
      result: {
        rateLimits: { limitId: "codex", primary: { usedPercent: 7, windowDurationMins: 300 } },
      },
    });
    return;
  }
  if (message.method === "account/usage/read") {
    write({ id: message.id, result: { summary: {}, dailyUsageBuckets: [] } });
  }
});
