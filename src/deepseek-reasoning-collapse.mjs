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

// DeepSeek's chat-completions translation can surface the full reasoning chain
// as plaintext `reasoning_text`. OpenAI instead streams an opaque reasoning
// item with a short summary, which the desktop renders as a collapsed
// "Thinking" panel. Rewrite DeepSeek reasoning to that shape: no visible
// content, one summary item.
export class DeepseekReasoningCollapseSseTransform extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.seq = 0;
    this.reasoningId = undefined;
    this.summaryText = "";
    this.sawSummary = false;
    this.started = false;
    this.reasoningClosed = false;
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
    if (type === "response.output_item.added" && event?.item?.type === "reasoning") {
      this.started = true;
      this.reasoningId = event.item.id;
      this.push(rewrittenBlock(parsed, {
        ...event,
        item: { ...event.item, summary: [], content: undefined },
      }) + parsed.separator);
      this.push(syntheticBlock("response.reasoning_summary_part.added", {
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }, parsed) + parsed.separator);
      return;
    }
    if (
      type === "response.content_part.done" &&
      event?.part?.type === "reasoning_text"
    ) {
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
      if (delta && !this.sawSummary) this.summaryText += delta;
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
        if (item?.type !== "reasoning") return item;
        return {
          ...item,
          content: undefined,
          summary: (Array.isArray(item.summary) && item.summary.length > 0
            ? item.summary
            : this.summaryText
              ? [{ type: "summary_text", text: this.summaryText }]
              : []),
        };
      });
      if (output.length !== event.response.output.length) {
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
        content: undefined,
      },
    }, parsed) + parsed.separator);
    this.push(syntheticBlock("response.reasoning_summary_part.added", {
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
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
          return { ...item, content: undefined, summary };
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
