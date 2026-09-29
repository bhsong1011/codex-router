import { spawn } from "node:child_process";
import readline from "node:readline";

import { storeAccountUsage } from "./account-usage-cache.mjs";
import { killProcessTree } from "./codex-account-usage.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

// Reading account usage used to spawn a `codex app-server`, ask two questions
// and kill it inside about a second. Every one of those startups begins Codex's
// marketplace auto-upgrade on a detached thread, and the clone it starts
// outlives the process that started it: `git` finishes a full copy into
// `$CODEX_HOME/.tmp/marketplaces/.staging/marketplace-upgrade-*`, neither the
// child nor the temp-directory destructor is ever reaped, and Codex has no
// sweep for that directory (openai/codex#47735, #21005). Here that stranded
// 116G in three days.
//
// One process, kept alive, does not have that problem: the upgrade it starts
// gets to finish, the copy is moved into place or dropped, and nothing is left
// behind. Measured on this machine -- three reads over two minutes through one
// session: one spawn, zero staging directories.
//
// The session lives in the router service because that is the only long-lived
// process we own. `codex-router account` is a one-shot, so it reads what this
// publishes (see account-usage-cache.mjs) and keeps its own spawn as a fallback
// for when the router is not running.

const INITIALIZE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000];

export function createCodexAppServerSession({
  binary,
  spawnImpl = spawn,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  initializeTimeoutMs = INITIALIZE_TIMEOUT_MS,
  onEvent = () => {},
} = {}) {
  const state = {
    child: null,
    lines: null,
    ready: null,
    nextId: 1,
    pending: new Map(),
    spawns: 0,
    queue: Promise.resolve(),
  };

  function failPending(error) {
    for (const [, entry] of state.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    state.pending.clear();
  }

  // Every path that loses the process comes through here, so the next read
  // always finds `ready` cleared and starts a fresh one rather than writing
  // into a dead pipe.
  function teardown(error) {
    const child = state.child;
    const viaShell = Boolean(state.viaShell);
    state.child = null;
    state.ready = null;
    state.viaShell = false;
    try {
      state.lines?.close();
    } catch {}
    state.lines = null;
    if (child) killProcessTree(child, viaShell);
    if (error) failPending(error);
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // The server sends notifications with no id. Ignoring them is what keeps
    // an unprompted message from being mistaken for a reply.
    if (message.id === undefined || message.id === null) {
      onEvent({ kind: "notification", method: message.method });
      return;
    }
    const entry = state.pending.get(message.id);
    if (!entry) {
      onEvent({ kind: "unmatched-reply", id: message.id });
      return;
    }
    state.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method} failed`));
    else entry.resolve(message.result);
  }

  function request(method, params, timeoutMs = requestTimeoutMs) {
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer, method });
      state.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  function start() {
    if (state.ready) return state.ready;
    state.ready = new Promise((resolve, reject) => {
      state.spawns += 1;
      onEvent({ kind: "spawn", count: state.spawns });
      const target = spawnableCommand(binary, ["app-server"]);
      const child = spawnImpl(target.command, target.args, {
        ...target.options,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      state.child = child;
      state.viaShell = Boolean(target.options.windowsVerbatimArguments);
      state.lines = readline.createInterface({ input: child.stdout });
      state.lines.on("line", handleLine);
      child.once("error", () => teardown(new Error("the Codex app-server could not be started")));
      child.once("exit", (code) => {
        onEvent({ kind: "exit", code });
        teardown(new Error(`the Codex app-server exited (${code ?? "signal"})`));
      });

      const id = state.nextId++;
      const timer = setTimeout(() => {
        reject(new Error(`initialize timed out after ${initializeTimeoutMs}ms`));
        teardown(new Error("initialize timed out"));
      }, initializeTimeoutMs);
      state.pending.set(id, {
        method: "initialize",
        timer,
        reject,
        resolve: () => {
          clearTimeout(timer);
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          resolve();
        },
      });
      child.stdin.write(
        `${JSON.stringify({
          id,
          method: "initialize",
          params: {
            clientInfo: {
              name: "codex_router_tray",
              title: "Codex Router Tray",
              version: "0.4.0",
            },
            capabilities: { experimentalApi: true },
          },
        })}\n`,
      );
    });
    return state.ready;
  }

  // Reads are serialized: one outstanding request pair at a time, so two
  // refreshes can never interleave on the pipe.
  function readRaw() {
    const run = state.queue.then(async () => {
      if (discoveryDisabled()) {
        throw new Error("Credential discovery is disabled (--no-discovery); the Codex account is not read.");
      }
      if (!binary) throw new Error("the Codex app-server could not be started: no Codex binary was found");
      await start();
      const [limits, usage] = await Promise.all([
        request("account/rateLimits/read", null),
        request("account/usage/read", null),
      ]);
      return { limits, usage };
    });
    // Keep the chain alive after a rejection: one bad read must not wedge
    // every read after it.
    state.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    readRaw,
    stop: () => teardown(null),
    stats: () => ({ spawns: state.spawns, inFlight: state.pending.size }),
  };
}

export function restartDelayMs(consecutiveFailures) {
  return RESTART_BACKOFF_MS[Math.min(consecutiveFailures, RESTART_BACKOFF_MS.length) - 1];
}

// Publishes what the session reads into the cache every other process already
// consults. A failed refresh leaves the previous reading in place and backs off,
// so a Codex that cannot start costs one process per attempt, not a storm.
export function startAccountUsageRefresh({
  session,
  intervalMs = 60_000,
  store = storeAccountUsage,
  compose,
  quiet = process.env.CODEX_ROUTER_QUIET === "1",
  log = (message) => process.stderr.write(`[codex-router] ${message}\n`),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let failures = 0;
  let refreshing = false;
  let stopped = false;
  let timer = null;

  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const value = await compose();
      store({ value });
      failures = 0;
    } catch (error) {
      failures += 1;
      if (!quiet) {
        log(`account usage refresh ${failures} failed: ${error.message}`);
      }
    } finally {
      refreshing = false;
      schedule();
    }
  }

  function schedule() {
    if (stopped) return;
    // One timer at a time. Rescheduling without clearing used to leave the
    // previous interval running, so each cycle added another refresher.
    if (timer) clearTimer(timer);
    const delay = failures ? restartDelayMs(failures) : intervalMs;
    timer = setTimer(refresh, delay);
    timer?.unref?.();
  }

  // The first refresh schedules the next one when it settles, so a failure
  // already backs off before any timer exists.
  void refresh();

  return {
    refresh,
    stop: () => {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
