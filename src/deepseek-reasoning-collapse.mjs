import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_DEFERRED_MESSAGE_BYTES = 64 * 1024;

function eventBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndex = lines.findIndex((line) => line.startsWith("data:"));
  if (dataLineIndex === -1) return undefined;
  const dataText = lines[dataLineIndex].slice(5).trimStart();
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    return { lines, dataLineIndex, newline, event: JSON.parse(dataText) };
  } catch {
    return undefined;
  }
}

function rewrittenBlock(parsed, event) {
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return lines.join(parsed.newline);
}

function syntheticBlock(type, event, parsed) {
  const hasEventLine = parsed.lines.some((line) => line.startsWith("event:"));
  const lines = hasEventLine ? [`event: ${type}`] : [];
  lines.push(`data: ${JSON.stringify({ type, ...event })}`);
  return lines.join(parsed.newline);
}

function outputText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function reasoningText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "reasoning_text")
    .map((part) =>
      typeof part.text === "string"
        ? part.text
        : typeof part.reasoning === "string"
          ? part.reasoning
          : "",
    )
    .join("");
}

function finalAnswerMessage(item) {
  return item?.type === "message"
    ? { ...item, phase: "final_answer" }
    : item;
}

// DeepSeek's chat-completions translation can surface the full reasoning chain
// as plaintext `reasoning_text`. Keep the opaque payload for DeepSeek's
// required follow-up replay, while adding a summary the desktop renders in a
// collapsed "Thinking" panel.
export class DeepseekReasoningCollapseSseTransform extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.seq = 0;
    this.reasoningId = undefined;
    this.reasoningContent = [];
    this.reasoningText = "";
    this.summaryText = "";
    this.sawSummary = false;
    this.started = false;
    this.reasoningClosed = false;
    this.emptyToolReasoning = undefined;
    this.toolCommentaryPending = false;
    this.deferredMessages = [];
    this.messages = new Map();
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += this.decoder.write(chunk);
    const separator = this.buffer.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    let index;
    while ((index = this.buffer.indexOf(separator)) !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + separator.length);
      const parsed = eventBlock(block);
      if (parsed) this.handleEvent({ ...parsed, raw: block, separator });
      else this.push(block + separator);
    }
    callback();
  }

  _flush(callback) {
    this.buffer += this.decoder.end();
    if (this.buffer) {
      const parsed = eventBlock(this.buffer);
      if (parsed) this.handleEvent({ ...parsed, raw: this.buffer, separator: "" });
      else this.push(this.buffer);
    }
    this.flushDeferredMessages();
    callback();
  }

  handleEvent(parsed) {
    const { event } = parsed;
    const type = event?.type;
    if (
      type === "response.output_item.added" &&
      ["function_call", "custom_tool_call"].includes(event?.item?.type)
    ) {
      this.discardDeferredMessages();
      this.startEmptyToolReasoning(parsed, event.output_index ?? 0);
      this.toolCommentaryPending = true;
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (type === "response.output_item.added" && event?.item?.type === "reasoning") {
      this.started = true;
      this.reasoningId = event.item.id;
      this.reasoningContent = Array.isArray(event.item.content) ? event.item.content : [];
      this.push(rewrittenBlock(parsed, {
        ...event,
        item: { ...event.item, summary: [], content: this.reasoningContent },
      }) + parsed.separator);
      this.push(syntheticBlock("response.reasoning_summary_part.added", {
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }, parsed) + parsed.separator);
      return;
    }
    if (type === "response.output_item.added" && event?.item?.type === "message") {
      const state = this.messageState(event.item.id);
      if (this.toolCommentaryPending && state) {
        this.toolCommentaryPending = false;
        state.suppressed = true;
        return;
      }
      this.flushDeferredMessages();
      state.deferred = {
        blocks: [rewrittenBlock(parsed, {
          ...event,
          item: finalAnswerMessage(event.item),
        }) + parsed.separator],
        bytes: Buffer.byteLength(parsed.raw + parsed.separator),
        outputIndex: event.output_index ?? 0,
        text: "",
      };
      this.deferredMessages.push(state);
      return;
    }
    if (type === "response.output_text.delta" && typeof event?.delta === "string") {
      const state = this.messageState(event.item_id);
      if (!state) {
        this.push(parsed.raw + parsed.separator);
        return;
      }
      if (state.deferred) {
        this.appendDeferredMessage(state, parsed, event.delta);
        return;
      }
      if (state.suppressed) return;
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (type === "response.output_text.done") {
      const state = this.messages.get(event?.item_id);
      if (state?.deferred) {
        this.appendDeferredMessage(state, parsed, event.text);
        return;
      }
      if (state?.suppressed) return;
    }
    if (type === "response.content_part.done" && event?.part?.type === "output_text") {
      const state = this.messages.get(event?.item_id);
      if (state?.deferred) {
        this.appendDeferredMessage(state, parsed, event.part.text);
        return;
      }
      if (state?.suppressed) return;
    }
    if (
      type === "response.output_item.done" &&
      ["function_call", "custom_tool_call"].includes(event?.item?.type)
    ) {
      this.discardDeferredMessages();
      this.startEmptyToolReasoning(parsed, event.output_index ?? 0);
      this.toolCommentaryPending = true;
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const state = this.messages.get(event.item.id);
      if (state?.deferred) {
        this.appendDeferredMessage(state, {
          ...parsed,
          raw: rewrittenBlock(parsed, {
            ...event,
            item: finalAnswerMessage(event.item),
          }),
        }, outputText(event.item.content));
        return;
      }
      if (state?.suppressed) return;
    }
    if (
      type === "response.content_part.done" &&
      event?.part?.type === "reasoning_text"
    ) {
      this.reasoningContent = [event.part];
      this.reasoningText ||= reasoningText(this.reasoningContent);
      this.push(parsed.raw + parsed.separator);
      this.closeReasoning(parsed);
      return;
    }
    if (type === "response.reasoning_summary_text.delta") {
      this.ensureStarted(parsed);
      if (typeof event.delta === "string" && event.delta) {
        this.sawSummary = true;
        this.summaryText += event.delta;
      }
      this.push(syntheticBlock("response.reasoning_summary_text.delta", {
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        delta: event.delta,
      }, parsed) + parsed.separator);
      return;
    }
    if (type === "response.reasoning_text.delta") {
      this.ensureStarted(parsed);
      const delta = typeof event.delta === "string" ? event.delta : event.part?.text ?? "";
      this.reasoningText += delta;
      if (delta && !this.sawSummary) this.summaryText += delta;
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (
      type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_part.done" ||
      type === "response.reasoning_summary_text.done" ||
      type === "response.reasoning_text.done"
    ) {
      return;
    }
    if (type === "response.output_item.done" && event?.item?.type === "reasoning") {
      if (!this.started) {
        this.started = true;
        this.reasoningId = event.item.id;
      }
      if (Array.isArray(event.item.content) && event.item.content.length > 0) {
        this.reasoningContent = event.item.content;
        this.reasoningText ||= reasoningText(event.item.content);
      }
      if (!this.sawSummary && Array.isArray(event.item.summary)) {
        this.summaryText ||= event.item.summary
          .filter((part) => part?.type === "summary_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
      }
      this.closeReasoning(parsed);
      return;
    }
    if (type === "response.completed" && Array.isArray(event?.response?.output)) {
      this.flushDeferredMessages();
      if (this.started && !this.reasoningClosed) this.closeReasoning(parsed);
      let changed = false;
      const sourceOutput = this.emptyToolReasoning
        ? [this.emptyToolReasoning, ...event.response.output]
        : event.response.output;
      const output = sourceOutput.flatMap((item) => {
        const state = this.messages.get(item?.id);
        if (state?.suppressed) {
          changed = true;
          return [];
        }
        if (item?.type === "reasoning") {
          return [{
            ...item,
            summary: (Array.isArray(item.summary) && item.summary.length > 0
              ? item.summary
              : this.summaryText
                ? [{ type: "summary_text", text: this.summaryText }]
                : []),
          }];
        }
        return [finalAnswerMessage(item)];
      });
      if (changed || output.some((item, index) => item !== event.response.output[index])) {
        this.push(rewrittenBlock(parsed, {
          ...event,
          response: { ...event.response, output },
        }) + parsed.separator);
        return;
      }
    }
    this.push(parsed.raw + parsed.separator);
  }

  ensureStarted(parsed) {
    if (this.started) return;
    this.started = true;
    this.seq += 1;
    this.reasoningId = `rs_collapse_${Date.now()}_${this.seq}`;
    this.push(syntheticBlock("response.output_item.added", {
      output_index: 0,
      item: {
        id: this.reasoningId,
        type: "reasoning",
        status: "in_progress",
        summary: [],
        content: [],
      },
    }, parsed) + parsed.separator);
    this.push(syntheticBlock("response.reasoning_summary_part.added", {
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }, parsed) + parsed.separator);
  }

  messageState(id) {
    if (typeof id !== "string" || !id) return undefined;
    let state = this.messages.get(id);
    if (!state) {
      state = { deferred: undefined, suppressed: false };
      this.messages.set(id, state);
    }
    return state;
  }

  appendDeferredMessage(state, parsed, text) {
    const deferred = state?.deferred;
    if (!deferred) return;
    const block = parsed.raw + parsed.separator;
    deferred.blocks.push(block);
    deferred.bytes += Buffer.byteLength(block);
    if (deferred.bytes > MAX_DEFERRED_MESSAGE_BYTES) {
      this.flushDeferredMessages();
      return;
    }
    if (typeof text !== "string" || !text) return;
    deferred.text += deferred.text && text.startsWith(deferred.text)
      ? text.slice(deferred.text.length)
      : text;
  }

  flushDeferredMessages() {
    for (const state of this.deferredMessages.splice(0)) {
      const deferred = state.deferred;
      if (!deferred) continue;
      state.deferred = undefined;
      this.push(deferred.blocks.join(""));
    }
  }

  discardDeferredMessages() {
    for (const state of this.deferredMessages.splice(0)) {
      if (!state.deferred) continue;
      state.deferred = undefined;
      state.suppressed = true;
    }
  }

  startEmptyToolReasoning(parsed, outputIndex) {
    if (this.started || this.emptyToolReasoning) return;
    this.seq += 1;
    const item = {
      id: `rs_tool_${Date.now()}_${this.seq}`,
      type: "reasoning",
      status: "completed",
      summary: [],
      content: [],
    };
    this.emptyToolReasoning = item;
    this.push(syntheticBlock("response.output_item.added", {
      output_index: outputIndex,
      item: { ...item, status: "in_progress" },
    }, parsed) + parsed.separator);
    this.push(syntheticBlock("response.output_item.done", {
      output_index: outputIndex,
      item,
    }, parsed) + parsed.separator);
  }

  closeReasoning(parsed) {
    if (!this.started || this.reasoningClosed) return;
    this.reasoningClosed = true;
    const text = this.summaryText;
    const template = parsed ?? { lines: ["data: {}"], dataLineIndex: 0, newline: "\n" };
    this.push(syntheticBlock("response.reasoning_summary_text.done", {
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      text,
    }, template) + (parsed ? parsed.separator : ""));
    this.push(syntheticBlock("response.reasoning_summary_part.done", {
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text },
    }, template) + (parsed ? parsed.separator : ""));
    this.push(syntheticBlock("response.output_item.done", {
      output_index: 0,
      item: {
        id: this.reasoningId,
        type: "reasoning",
        status: "completed",
        summary: text ? [{ type: "summary_text", text }] : [],
        content: this.reasoningContent.length > 0
          ? this.reasoningContent
          : this.reasoningText
            ? [{ type: "reasoning_text", text: this.reasoningText }]
            : [],
      },
    }, template) + (parsed ? parsed.separator : ""));
  }
}

class DeepseekReasoningCollapseJsonTransform extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    this.body = "";
  }

  _transform(chunk, _encoding, callback) {
    this.body += this.decoder.write(chunk);
    callback();
  }

  _flush(callback) {
    this.body += this.decoder.end();
    try {
      const payload = JSON.parse(this.body);
      if (Array.isArray(payload?.output)) {
        payload.output = payload.output.map((item) => {
          if (item?.type !== "reasoning") return finalAnswerMessage(item);
          const text = Array.isArray(item.content)
            ? item.content
                .filter((part) =>
                  (part?.type === "reasoning_text" || part?.type === "output_text") &&
                  typeof part.text === "string",
                )
                .map((part) => part.text)
                .join("")
            : "";
          const summary = Array.isArray(item.summary) && item.summary.length > 0
            ? item.summary
            : text
              ? [{ type: "summary_text", text }]
              : [];
          return { ...item, summary };
        });
      }
      this.push(JSON.stringify(payload));
    } catch {
      this.push(this.body);
    }
    callback();
  }
}

export function deepseekReasoningCollapseTransform(provider, contentType = "") {
  if (provider?.id !== "deepseek") return undefined;
  const mediaType = String(contentType).split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/event-stream") return new DeepseekReasoningCollapseSseTransform();
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return new DeepseekReasoningCollapseJsonTransform();
  }
  return undefined;
}
