import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeepSeekDelegation } from "../src/deepseek-delegation.mjs";
import { handleMcp } from "../src/deepseek-delegation-mcp.mjs";

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      writable: true,
      write: (line) => this.handle(JSON.parse(line)),
    };
  }

  reply(payload) {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(payload)}\n`));
  }

  handle(message) {
    if (message.method === "initialize") return this.reply({ id: message.id, result: {} });
    if (message.method === "thread/start") {
      return this.reply({ id: message.id, result: { thread: { id: "thread-deepseek" } } });
    }
    if (message.method === "turn/start" || message.method === "turn/steer") {
      return this.reply({ id: message.id, result: { turn: { id: `turn-${message.id}` } } });
    }
    if (message.method === "turn/interrupt") {
      this.reply({ id: message.id, result: {} });
      return this.reply({ method: "turn/completed", params: { turn: { threadId: "thread-deepseek", status: "interrupted" } } });
    }
    return undefined;
  }

  kill() {
    this.emit("exit", 0, "SIGTERM");
    return true;
  }
}

async function settled() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("delegation creates a durable App Server DeepSeek thread that can be steered and interrupted", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-delegation-"));
  const fake = new FakeAppServer();
  const manager = new DeepSeekDelegation({
    stateDir,
    codexBin: process.execPath,
    spawnImpl: () => fake,
  });

  const created = manager.create({ task: "Inspect this repository.", cwd: process.cwd() });
  assert.equal(created.status, "starting");
  await settled();
  const running = manager.status(created.id);
  assert.equal(running.status, "running");
  assert.equal(running.threadId, "thread-deepseek");
  assert.equal(running.model, "deepseek/deepseek-v4-flash");

  const steered = manager.message(created.id, "Focus on the failing test first.");
  assert.equal(steered.messages.length, 1);
  const interrupted = manager.cancel(created.id);
  assert.equal(interrupted.status, "interrupting");
  await settled();
  const result = await manager.wait(created.id, 100);
  assert.equal(result.status, "interrupted");
  assert.equal(existsSync(path.join(stateDir, created.id, "job.json")), true);
  assert.match(readFileSync(path.join(stateDir, created.id, "events.jsonl"), "utf8"), /turn\/steer/);
});

test("delegation rejects broad sandbox escalation and unsupported paths", () => {
  const manager = new DeepSeekDelegation({
    stateDir: mkdtempSync(path.join(os.tmpdir(), "codex-router-delegation-")),
    codexBin: process.execPath,
    spawnImpl: () => new FakeAppServer(),
  });
  assert.throws(
    () => manager.create({ task: "Do work", cwd: process.cwd(), sandbox: "danger-full-access" }),
    /read-only or workspace-write/,
  );
  assert.throws(() => manager.create({ task: "Do work", cwd: "relative" }), /existing absolute directory/);
});

test("MCP exposes only the DeepSeek delegation control surface", async () => {
  const initialized = await handleMcp({ method: "initialize" });
  assert.equal(initialized.serverInfo.name, "codex-router-deepseek-delegation");
  const listed = await handleMcp({ method: "tools/list" });
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    [
      "deepseek_delegate",
      "deepseek_status",
      "deepseek_message",
      "deepseek_wait",
      "deepseek_cancel",
      "deepseek_result",
    ],
  );
});
