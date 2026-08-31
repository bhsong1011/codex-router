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

test("DeepSeek reasoning collapse rewrites reasoning to a summary and drops the full text", async () => {
  const input = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_a","output_index":0,"delta":"We"}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_b","output_index":0,"delta":" need answer"}\n\n',
    'data: {"type":"response.content_part.done","item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"reasoning_text","reasoning":"We need answer to the user."}}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","status":"completed","content":[{"type":"reasoning_text","text":"full hidden chain"}]}}\n\n',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"OK"}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"OK"}]}}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const output = await collect(
    deepseekReasoningCollapseTransform(
      { id: "deepseek" },
      "text/event-stream",
    ),
    input,
  );

  assert.ok(!output.includes("reasoning_text"));
  assert.ok(!output.includes('"reasoning":"We need answer to the user."'));
  assert.ok(!output.includes('"content":[{"type":"reasoning_text"'));
  assert.match(output, /"type":"summary_text"/);
  assert.ok(output.includes('"delta":"We"'));
  assert.ok(output.includes('"delta":" need answer"'));
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
