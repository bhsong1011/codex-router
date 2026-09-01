import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

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
    this.toolCommentaryPending = false;
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
    callback();
  }

  handleEvent(parsed) {
    const { event } = parsed;
    const type = event?.type;
    if (type === "response.output_item.added" && event?.item?.type === "function_call") {
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
        this.startToolCommentary(parsed, state, event);
        return;
      }
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (type === "response.output_text.delta" && typeof event?.delta === "string") {
      const state = this.messageState(event.item_id);
      if (!state) {
        this.push(parsed.raw + parsed.separator);
        return;
      }
      if (state.commentary) {
        this.appendToolCommentary(parsed, state, event.delta);
        return;
      }
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (type === "response.output_text.done") {
      const state = this.messages.get(event?.item_id);
      if (state?.commentary) {
        this.appendToolCommentary(parsed, state, event.text);
        this.closeToolCommentary(parsed, state);
        return;
      }
    }
    if (type === "response.content_part.done" && event?.part?.type === "output_text") {
      const state = this.messages.get(event?.item_id);
      if (state?.commentary) {
        this.appendToolCommentary(parsed, state, event.part.text);
        this.closeToolCommentary(parsed, state);
        return;
      }
    }
    if (type === "response.output_item.done" && event?.item?.type === "function_call") {
      this.toolCommentaryPending = true;
      this.push(parsed.raw + parsed.separator);
      return;
    }
    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const state = this.messages.get(event.item.id);
      if (state?.commentary) {
        this.appendToolCommentary(
          parsed,
          state,
          outputText(event.item.content),
        );
        this.closeToolCommentary(parsed, state);
        return;
      }
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
      if (this.started && !this.reasoningClosed) this.closeReasoning(parsed);
      const output = event.response.output.map((item) => {
        if (item?.type === "reasoning") {
          return {
            ...item,
            summary: (Array.isArray(item.summary) && item.summary.length > 0
              ? item.summary
              : this.summaryText
                ? [{ type: "summary_text", text: this.summaryText }]
                : []),
          };
        }
        const state = this.messages.get(item?.id);
        if (state?.commentary) {
          this.appendToolCommentary(parsed, state, outputText(item.content));
          this.closeToolCommentary(parsed, state);
          return this.toolCommentaryItem(state);
        }
        return item;
      });
      if (output.some((item, index) => item !== event.response.output[index])) {
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
      state = { commentary: undefined };
      this.messages.set(id, state);
    }
    return state;
  }

  startToolCommentary(parsed, state, event) {
    this.seq += 1;
    state.commentary = {
      id: `rs_commentary_${Date.now()}_${this.seq}`,
      outputIndex: event.output_index ?? 0,
      text: "",
      closed: false,
    };
    const commentary = state.commentary;
    this.push(syntheticBlock("response.output_item.added", {
      output_index: commentary.outputIndex,
      item: {
        id: commentary.id,
        type: "reasoning",
        status: "in_progress",
        summary: [],
        content: undefined,
      },
    }, parsed) + parsed.separator);
    this.push(syntheticBlock("response.reasoning_summary_part.added", {
      item_id: commentary.id,
      output_index: commentary.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }, parsed) + parsed.separator);
  }

  appendToolCommentary(parsed, state, text) {
    const commentary = state?.commentary;
    if (!commentary || commentary.closed || typeof text !== "string" || !text) return;
    const delta = commentary.text && text.startsWith(commentary.text)
      ? text.slice(commentary.text.length)
      : text;
    if (!delta) return;
    commentary.text += delta;
    this.push(syntheticBlock("response.reasoning_summary_text.delta", {
      item_id: commentary.id,
      output_index: commentary.outputIndex,
      summary_index: 0,
      delta,
    }, parsed) + parsed.separator);
  }

  toolCommentaryItem(state) {
    const commentary = state.commentary;
    return {
      id: commentary.id,
      type: "reasoning",
      status: "completed",
      summary: commentary.text
        ? [{ type: "summary_text", text: commentary.text }]
        : [],
    };
  }

  closeToolCommentary(parsed, state) {
    const commentary = state?.commentary;
    if (!commentary || commentary.closed) return;
    commentary.closed = true;
    const item = this.toolCommentaryItem(state);
    this.push(syntheticBlock("response.reasoning_summary_text.done", {
      item_id: commentary.id,
      output_index: commentary.outputIndex,
      summary_index: 0,
      text: commentary.text,
    }, parsed) + parsed.separator);
    this.push(syntheticBlock("response.reasoning_summary_part.done", {
      item_id: commentary.id,
      output_index: commentary.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: commentary.text },
    }, parsed) + parsed.separator);
    this.push(syntheticBlock("response.output_item.done", {
      output_index: commentary.outputIndex,
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
          if (item?.type !== "reasoning") return item;
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
