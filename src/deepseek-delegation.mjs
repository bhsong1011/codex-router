import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { findCodexBinary, spawnableCommand } from "./codex-binary.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const DEEPSEEK_DELEGATION_MODEL = "deepseek/deepseek-v4-flash";
export const DEEPSEEK_DELEGATION_SERVER = "codex-router";
const TERMINAL = new Set(["completed", "failed", "interrupted"]);
const SANDBOXES = new Set(["read-only", "workspace-write"]);

function now() {
  return new Date().toISOString();
}

function assertText(value, name, { max = 100_000 } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  if (value.length > max) throw new Error(`${name} is too long.`);
  return value.trim();
}

function jobId() {
  return `ds_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function isTerminal(status) {
  return TERMINAL.has(status);
}

function jsonLine(callback) {
  let buffered = "";
  return (chunk) => {
    buffered += String(chunk);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        callback(JSON.parse(line));
      } catch {
        callback({ type: "router.raw", text: line });
      }
    }
  };
}

function project(job) {
  const {
    task,
    processId,
    ...safe
  } = job;
  return safe;
}

export class DeepSeekDelegation {
  constructor({
    stateDir = path.join(STATE_DIR, "deepseek-delegation"),
    codexBin = findCodexBinary(),
    spawnImpl = spawn,
    clock = now,
  } = {}) {
    this.stateDir = stateDir;
    this.codexBin = codexBin;
    this.spawnImpl = spawnImpl;
    this.clock = clock;
    this.children = new Map();
  }

  jobDir(id) {
    return path.join(this.stateDir, id);
  }

  jobPath(id) {
    return path.join(this.jobDir(id), "job.json");
  }

  eventPath(id) {
    return path.join(this.jobDir(id), "events.jsonl");
  }

  ensureJobDir(id) {
    mkdirSync(this.jobDir(id), { recursive: true, mode: 0o700 });
  }

  save(job) {
    this.ensureJobDir(job.id);
    job.updatedAt = this.clock();
    const target = this.jobPath(job.id);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
    return job;
  }

  event(job, event) {
    this.ensureJobDir(job.id);
    const target = this.eventPath(job.id);
    appendFileSync(target, `${JSON.stringify({ at: this.clock(), event })}\n`, { encoding: "utf8", mode: 0o600 });
    protectPrivateFile(target);
  }

  read(id) {
    const normalized = assertText(id, "job_id", { max: 160 });
    const target = this.jobPath(normalized);
    if (!existsSync(target)) throw new Error(`Unknown DeepSeek delegation job: ${normalized}`);
    try {
      return JSON.parse(readFileSync(target, "utf8"));
    } catch {
      throw new Error(`DeepSeek delegation job ${normalized} is unreadable.`);
    }
  }

  create({ task, cwd, sandbox = "read-only" }) {
    if (!this.codexBin) throw new Error("The Codex binary was not found; cannot start a DeepSeek worker.");
    const prompt = assertText(task, "task");
    const workingDirectory = assertText(cwd, "cwd", { max: 8_000 });
    if (!path.isAbsolute(workingDirectory) || !existsSync(workingDirectory)) {
      throw new Error("cwd must be an existing absolute directory.");
    }
    if (!SANDBOXES.has(sandbox)) throw new Error("sandbox must be read-only or workspace-write.");
    const job = {
      id: jobId(),
      model: DEEPSEEK_DELEGATION_MODEL,
      cwd: workingDirectory,
      sandbox,
      task: prompt,
      status: "starting",
      createdAt: this.clock(),
      updatedAt: this.clock(),
      lastActivityAt: this.clock(),
      messages: [],
    };
    this.save(job);
    this.start(job, { initial: true });
    return project(job);
  }

  start(job, { initial }) {
    const target = spawnableCommand(this.codexBin, ["app-server", "--stdio"]);
    const child = this.spawnImpl(target.command, target.args, {
      ...target.options,
      cwd: job.cwd,
      windowsHide: true,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.set(job.id, { child, nextRequestId: 1 });
    job.processId = child.pid;
    job.status = "starting";
    this.event(job, { type: "router.started", initial });
    this.save(job);
    child.stdout.on("data", jsonLine((message) => this.onMessage(job.id, message)));
    child.stderr.on("data", (chunk) => this.event(job, { type: "router.stderr", text: String(chunk).slice(-8_000) }));
    child.once("error", (error) => this.finish(job.id, "failed", error.message));
    child.once("exit", (code, signal) => {
      const latest = this.read(job.id);
      this.children.delete(job.id);
      if (!isTerminal(latest.status)) this.finish(job.id, "failed", `Codex App Server exited (${code ?? signal ?? "unknown"}).`);
    });
    this.request(job.id, "initialize", {
      clientInfo: { name: "codex_router_deepseek_delegation", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    }, "initialize");
  }

  request(id, method, params, kind) {
    const running = this.children.get(id);
    if (!running?.child.stdin?.writable) throw new Error(`DeepSeek delegation job ${id} is not connected.`);
    const requestId = running.nextRequestId++;
    running.child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    this.event(this.read(id), { type: "router.request", requestId, method, kind });
    return requestId;
  }

  notify(id, method, params) {
    const running = this.children.get(id);
    if (!running?.child.stdin?.writable) throw new Error(`DeepSeek delegation job ${id} is not connected.`);
    running.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  onMessage(id, message) {
    let job;
    try {
      job = this.read(id);
    } catch {
      return;
    }
    job.lastActivityAt = this.clock();
    this.event(job, message);
    if (message.error) {
      this.finish(id, "failed", String(message.error.message || "Codex App Server request failed."));
      return;
    }
    if (message.id === 1) {
      this.notify(id, "initialized", {});
      this.request(id, "thread/start", {
        approvalPolicy: "never",
        cwd: job.cwd,
        model: job.model,
        modelProvider: DEEPSEEK_DELEGATION_SERVER,
        sandbox: job.sandbox,
      }, "thread/start");
      return;
    }
    if (message.id === 2) {
      const threadId = message.result?.thread?.id;
      if (typeof threadId !== "string" || !threadId) {
        this.finish(id, "failed", "Codex App Server did not return a DeepSeek thread id.");
        return;
      }
      job.threadId = threadId;
      job.status = "running";
      this.save(job);
      this.request(id, "turn/start", {
        threadId,
        input: [{ type: "text", text: job.task }],
      }, "turn/start");
      return;
    }
    if (message.method === "turn/completed") {
      const turn = message.params?.turn || {};
      if (job.threadId && turn.threadId && turn.threadId !== job.threadId) return;
      const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
      this.finish(id, status, turn.error?.message);
      return;
    }
    this.save(job);
  }

  finish(id, status, detail) {
    const job = this.read(id);
    if (isTerminal(job.status)) return project(job);
    job.status = status;
    job.finishedAt = this.clock();
    if (detail) job.detail = String(detail).slice(0, 4_000);
    this.event(job, { type: "router.finished", status, ...(detail ? { detail: job.detail } : {}) });
    this.save(job);
    // A completed worker no longer needs a live App Server.  Leaving it
    // resident would leak one process per delegated task and make later
    // status reads look like active work.
    this.children.get(id)?.child?.kill();
    return project(job);
  }

  status(id) {
    return project(this.read(id));
  }

  message(id, text) {
    const job = this.read(id);
    const input = assertText(text, "message");
    if (isTerminal(job.status)) throw new Error(`DeepSeek delegation job ${job.id} is already ${job.status}.`);
    if (!job.threadId) throw new Error(`DeepSeek delegation job ${job.id} is still starting.`);
    job.messages.push({ at: this.clock(), text: input });
    this.save(job);
    this.request(job.id, "turn/steer", {
      threadId: job.threadId,
      input: [{ type: "text", text: input }],
    }, "turn/steer");
    return project(job);
  }

  cancel(id) {
    const job = this.read(id);
    if (isTerminal(job.status)) return project(job);
    if (!job.threadId) {
      const child = this.children.get(job.id)?.child;
      child?.kill();
      return this.finish(job.id, "interrupted", "Cancelled while starting.");
    }
    job.status = "interrupting";
    this.save(job);
    this.request(job.id, "turn/interrupt", { threadId: job.threadId }, "turn/interrupt");
    return project(job);
  }

  async wait(id, timeoutMs = 30_000) {
    const timeout = Number(timeoutMs);
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) {
      throw new Error("timeout_ms must be an integer between 0 and 60000.");
    }
    const deadline = Date.now() + timeout;
    for (;;) {
      const job = this.status(id);
      if (isTerminal(job.status) || Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  result(id) {
    const job = this.read(id);
    let events = "";
    const target = this.eventPath(job.id);
    if (existsSync(target)) events = readFileSync(target, "utf8").slice(-16_000);
    return { ...project(job), events };
  }
}
