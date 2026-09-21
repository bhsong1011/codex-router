import readline from "node:readline";

import { DeepSeekDelegation } from "./deepseek-delegation.mjs";

const manager = new DeepSeekDelegation();

const tools = [
  {
    name: "deepseek_delegate",
    description: "Start a DeepSeek worker that the current OpenAI parent manages. Returns a durable job_id.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      properties: {
        task: { type: "string" },
        cwd: { type: "string" },
        sandbox: { enum: ["read-only", "workspace-write"] },
      },
    },
  },
  {
    name: "deepseek_status",
    description: "Read a DeepSeek worker's current state and latest observable activity.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "deepseek_message",
    description: "Steer a running DeepSeek worker with a new instruction.",
    inputSchema: {
      type: "object",
      required: ["job_id", "message"],
      properties: { job_id: { type: "string" }, message: { type: "string" } },
    },
  },
  {
    name: "deepseek_wait",
    description: "Wait up to 60 seconds for a DeepSeek worker to finish or change state.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, timeout_ms: { type: "integer", minimum: 0, maximum: 60000 } },
    },
  },
  {
    name: "deepseek_cancel",
    description: "Interrupt a running DeepSeek worker.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
  {
    name: "deepseek_result",
    description: "Return a DeepSeek worker's final state and bounded event transcript.",
    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } },
  },
];

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function call(name, input = {}) {
  switch (name) {
    case "deepseek_delegate": return manager.create(input);
    case "deepseek_status": return manager.status(input.job_id);
    case "deepseek_message": return manager.message(input.job_id, input.message);
    case "deepseek_wait": return manager.wait(input.job_id, input.timeout_ms);
    case "deepseek_cancel": return manager.cancel(input.job_id);
    case "deepseek_result": return manager.result(input.job_id);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMcp(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "codex-router-deepseek-delegation", version: "1.0.0" } };
  }
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") return toolResult(await call(message.params?.name, message.params?.arguments));
  if (message.method === "notifications/initialized") return undefined;
  throw new Error(`Unsupported MCP method: ${message.method}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
      const result = await handleMcp(message);
      if (message.id !== undefined) reply({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (message?.id !== undefined) {
        reply({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
      }
    }
  }
}
