import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  deepseekReasoningCollapseTransform,
} from "../src/deepseek-reasoning-collapse.mjs";

function collect(transform, input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    transform.on("data", (chunk) => chunks.push(chunk));
    transform.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    transform.on("error", reject);
    Readable.from([Buffer.from(input)]).pipe(transform);
  });
}

function events(output) {
  return output
    .split("\n\n")
    .flatMap((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data || data === "data: [DONE]") return [];
      return [JSON.parse(data.slice(6))];
    });
}

test("DeepSeek reasoning collapse emits a summary while preserving replay content", async () => {
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_a","output_index":0,"delta":"We"}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_b","output_index":0,"delta":" need answer"}\n\n',
    'data: {"type":"response.content_part.done","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"reasoning_text","reasoning":"We need answer to the user."}}\n\n',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"OK"}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"OK"}]}}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[]}]}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const output = await collect(
    deepseekReasoningCollapseTransform(
      { id: "deepseek" },
      "text/event-stream",
    ),
    input,
  );

  assert.match(output, /"type":"reasoning_text"/);
  assert.match(output, /"reasoning":"We need answer to the user."/);
  assert.match(output, /"type":"reasoning"/);
  assert.match(output, /"type":"summary_text"/);
  assert.match(output, /"text":"We need answer"/);
  assert.ok(output.includes('"delta":"OK"'));
  assert.ok(output.includes('"type":"message"'));
  assert.ok(output.includes('"phase":"final_answer"'));
});

test("DeepSeek JSON responses preserve reasoning content for a follow-up", async () => {
  const input = JSON.stringify({
    output: [{
      id: "rs_1",
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "opaque replay payload" }],
      summary: [],
    }],
  });
  const output = await collect(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "application/json"),
    input,
  );
  const item = JSON.parse(output).output[0];

  assert.deepEqual(item.content, [{ type: "reasoning_text", text: "opaque replay payload" }]);
  assert.deepEqual(item.summary, [{ type: "summary_text", text: "opaque replay payload" }]);
});

test("DeepSeek suppresses post-tool commentary", async () => {
  const commentary = "I will verify the repository state, then apply the approved revert.";
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"function_call","name":"exec_command","arguments":"{}"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: commentary })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1", output_index: 1, content_index: 0, text: commentary })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: commentary }] } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [{ id: "call_1", type: "function_call", name: "exec_command", arguments: "{}" }, { id: "msg_1", type: "message", content: [{ type: "output_text", text: commentary }] }] } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const output = await collect(
    deepseekReasoningCollapseTransform(
      { id: "deepseek" },
      "text/event-stream",
    ),
    input,
  );
  const outputEvents = events(output);
  const completed = outputEvents.find((event) => event.type === "response.completed");

  assert.ok(
    !outputEvents.some(
      (event) =>
        event.type === "response.output_text.delta" &&
        event.delta === commentary,
    ),
  );
  assert.ok(
    !completed.response.output.some((item) => item.id === "msg_1"),
  );
  assert.ok(!outputEvents.some(
    (event) => event.type === "response.reasoning_summary_text.delta" && event.delta === commentary,
  ));
  assert.ok(completed.response.output.some((item) => item.id === "call_1"));
});

test("DeepSeek suppresses pre-tool commentary", async () => {
  const commentary = "I will verify the repository state before changing anything.";
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: commentary })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: commentary }] } })}\n\n`,
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"call_1","type":"function_call","name":"exec_command","arguments":"{}"}}\n\n',
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [{ id: "msg_1", type: "message", content: [{ type: "output_text", text: commentary }] }, { id: "call_1", type: "function_call", name: "exec_command", arguments: "{}" }] } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const outputEvents = events(await collect(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "text/event-stream"),
    input,
  ));
  const completed = outputEvents.find((event) => event.type === "response.completed");

  assert.ok(!outputEvents.some(
    (event) => event.type === "response.output_text.delta" && event.delta === commentary,
  ));
  assert.ok(!outputEvents.some(
    (event) => event.type === "response.reasoning_summary_text.delta" && event.delta === commentary,
  ));
  assert.ok(!completed.response.output.some((item) => item.id === "msg_1"));
});

test("DeepSeek releases an oversized deferred message unchanged", async () => {
  const commentary = "x".repeat(65 * 1024);
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: commentary })}\n\n`,
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"call_1","type":"function_call","name":"exec_command","arguments":"{}"}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const outputEvents = events(await collect(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "text/event-stream"),
    input,
  ));

  assert.ok(outputEvents.some(
    (event) => event.type === "response.output_text.delta" && event.delta === commentary,
  ));
  assert.ok(!outputEvents.some(
    (event) => event.type === "response.reasoning_summary_text.delta" && event.delta === commentary,
  ));
});

test("DeepSeek keeps the later answer visible after suppressed tool commentary", async () => {
  const commentary = "I will inspect the file.";
  const answer = "The file is valid.";
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"function_call","name":"exec_command","arguments":"{}"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_commentary","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_commentary", output_index: 1, content_index: 0, delta: commentary })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { id: "msg_commentary", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: commentary }] } })}\n\n`,
    'data: {"type":"response.output_item.added","output_index":2,"item":{"id":"msg_answer","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_answer", output_index: 2, content_index: 0, delta: answer })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 2, item: { id: "msg_answer", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer }] } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const outputEvents = events(await collect(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "text/event-stream"),
    input,
  ));

  assert.ok(!outputEvents.some(
    (event) => event.type === "response.reasoning_summary_text.delta" && event.delta === commentary,
  ));
  assert.ok(outputEvents.some(
    (event) =>
      event.type === "response.output_text.delta" &&
      event.item_id === "msg_answer" &&
      event.delta === answer,
  ));
});

test("DeepSeek suppresses post-custom-tool commentary", async () => {
  const commentary = "I will run the command now.";
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"custom_tool_call","name":"exec_command","input":"{}"}}\n\n',
    'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: commentary })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: commentary }] } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [{ id: "call_1", type: "custom_tool_call", name: "exec_command", input: "{}" }, { id: "msg_1", type: "message", content: [{ type: "output_text", text: commentary }] }] } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const outputEvents = events(await collect(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "text/event-stream"),
    input,
  ));
  const completed = outputEvents.find((event) => event.type === "response.completed");
  assert.ok(!outputEvents.some(
    (event) => event.type === "response.output_text.delta" && event.delta === commentary,
  ));
  assert.ok(!completed.response.output.some((item) => item.id === "msg_1"));
});

test("DeepSeek adds an empty reasoning item before a tool turn", async () => {
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"custom_tool_call","name":"exec_command","input":"{}"}}\n\n',
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [{ id: "call_1", type: "custom_tool_call", name: "exec_command", input: "{}" }] } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const outputEvents = events(await collect(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "text/event-stream"),
    input,
  ));
  const added = outputEvents.find(
    (event) => event.type === "response.output_item.added" && event.item?.type === "reasoning",
  );
  const completed = outputEvents.find((event) => event.type === "response.completed");

  assert.deepEqual(added.item.summary, []);
  assert.deepEqual(completed.response.output[0].summary, []);
  assert.equal(completed.response.output[0].type, "reasoning");
});

test("reasoning collapse leaves other providers alone", () => {
  assert.equal(
    deepseekReasoningCollapseTransform({ id: "openai" }, "text/event-stream"),
    undefined,
  );
  assert.equal(
    deepseekReasoningCollapseTransform({ id: "deepseek" }, "text/plain"),
    undefined,
  );
});
