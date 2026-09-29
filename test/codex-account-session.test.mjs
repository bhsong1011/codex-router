import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCodexAppServerSession,
  restartDelayMs,
  startAccountUsageRefresh,
} from "../src/codex-account-session.mjs";
import { cachedAccountUsage, storeAccountUsage } from "../src/account-usage-cache.mjs";

const STUB = path.join(import.meta.dirname, "stub-app-server.mjs");

function spawnCount(file) {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

// The refresh loop starts one cycle on construction, so tests observe that
// first cycle instead of racing it with a manual call.
async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the refresh loop");
}

// The session asks for `codex app-server`; the stub answers instead.
function stubSession({ dir, env = {}, ...options } = {}) {
  return createCodexAppServerSession({
    binary: process.execPath,
    spawnImpl: (_command, _args, opts) =>
      spawn(process.execPath, [STUB], {
        ...opts,
        env: { ...process.env, STUB_SPAWN_LOG: path.join(dir, "spawns.log"), ...env },
      }),
    ...options,
  });
}

test("many reads share one process", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-reuse-"));
  const session = stubSession({ dir });
  try {
    for (let i = 0; i < 5; i += 1) {
      const { limits } = await session.readRaw();
      assert.equal(limits.rateLimits.primary.usedPercent, 7);
    }
    assert.equal(session.stats().spawns, 1, "five reads must share one process");
    assert.equal(spawnCount(path.join(dir, "spawns.log")), 1);
  } finally {
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung request fails without wedging the session", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-hang-"));
  const session = stubSession({ dir, requestTimeoutMs: 400, env: { STUB_HANG_LIMITS: "1" } });
  try {
    await assert.rejects(session.readRaw(), /timed out/);
    assert.equal(session.stats().inFlight, 0, "a timed-out request must not stay pending");
    await assert.rejects(session.readRaw(), /timed out/, "the session stays usable for retries");
  } finally {
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a process that dies is replaced on the next read", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-respawn-"));
  let attempts = 0;
  const session = createCodexAppServerSession({
    binary: process.execPath,
    spawnImpl: (_command, _args, opts) => {
      attempts += 1;
      return spawn(process.execPath, [STUB], {
        ...opts,
        env: {
          ...process.env,
          STUB_SPAWN_LOG: path.join(dir, "spawns.log"),
          ...(attempts === 1 ? { STUB_DIE_AFTER_INIT: "1" } : {}),
        },
      });
    },
  });
  try {
    await assert.rejects(session.readRaw(), /exited|timed out/);
    const { limits } = await session.readRaw();
    assert.equal(limits.rateLimits.primary.usedPercent, 7);
    assert.equal(session.stats().spawns, 2);
  } finally {
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unprompted notification does not break the stream", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-noise-"));
  const seen = [];
  const session = stubSession({ dir, onEvent: (event) => seen.push(event.kind) });
  try {
    const first = await session.readRaw();
    const second = await session.readRaw();
    assert.deepEqual(first.limits, second.limits);
    assert.ok(seen.includes("notification"));
    assert.equal(session.stats().spawns, 1);
  } finally {
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refresh publishes a reading every other process can read back", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-publish-"));
  const cachePath = path.join(dir, "account-usage-cache.json");
  const session = stubSession({ dir });
  const refresh = startAccountUsageRefresh({
    session,
    quiet: true,
    compose: async () => {
      const { limits } = await session.readRaw();
      return { planType: "stub", usedPercent: limits.rateLimits.primary.usedPercent };
    },
    store: ({ value }) => storeAccountUsage({ value, cachePath }),
  });
  try {
    await waitFor(() => existsSync(cachePath));
    const seen = await cachedAccountUsage({
      cachePath,
      read: async () => {
        throw new Error("the cache must answer without a read");
      },
    });
    assert.deepEqual(seen, { planType: "stub", usedPercent: 7 });
  } finally {
    refresh.stop();
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing refresh backs off instead of respawning in a tight loop", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-backoff-"));
  const timers = [];
  const session = stubSession({ dir, env: { STUB_HANG_LIMITS: "1" }, requestTimeoutMs: 200 });
  const refresh = startAccountUsageRefresh({
    session,
    quiet: true,
    compose: () => session.readRaw(),
    store: () => {},
    setTimer: (fn, delay) => {
      timers.push({ fn, delay });
      return { unref() {} };
    },
    clearTimer: () => {},
  });
  try {
    await waitFor(() => timers.length >= 1);
    assert.equal(timers[0].delay, 1_000, "the first failure waits a second");
    await timers[0].fn();
    await waitFor(() => timers.length >= 2);
    assert.equal(timers[1].delay, 5_000, "the second failure waits longer");
    assert.deepEqual(
      timers.map((timer) => timer.delay),
      [1_000, 5_000],
      "consecutive failures must widen the interval",
    );
    assert.deepEqual(
      [restartDelayMs(1), restartDelayMs(2), restartDelayMs(9)],
      [1_000, 5_000, 300_000],
      "the backoff is capped so a broken Codex cannot cause a spawn storm",
    );
  } finally {
    refresh.stop();
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping the session kills the process it owns", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "account-session-stop-"));
  const session = stubSession({ dir });
  let pid;
  try {
    await session.readRaw();
    pid = Number(readFileSync(path.join(dir, "spawns.log"), "utf8").trim().split("\n")[0]);
    assert.ok(pid > 0);
    session.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(`/proc/${pid}`), false, "the child must not outlive the session");
  } finally {
    session.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
