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

function reasoningText(item) {
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter(
      (part) =>
        (part?.type === "reasoning_text" || part?.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function collapseReasoningItem(item) {
  if (item?.type !== "reasoning") return item;
  const text = reasoningText(item);
  if (!text && Array.isArray(item.summary)) return item;
  const summary = Array.isArray(item.summary) && item.summary.length > 0
    ? item.summary
    : text
      ? [{ type: "summary_text", text }]
      : [];
  return { ...item, content: undefined, summary };
}

// DeepSeek's chat-completions translation can surface the full reasoning chain
// as plaintext `reasoning_text`. OpenAI keeps reasoning opaque and only streams
// a summary, so the desktop collapses it. Strip the plaintext reasoning events
// and leave whatever summary the upstream stream already carries untouched.
export class DeepseekReasoningCollapseSseTransform extends Transform {
  constructor() {
    super();
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
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
    if (
      type === "response.content_part.done" &&
      event?.part?.type === "reasoning_text"
    ) {
      return;
    }
    if (type === "response.reasoning_text.delta" || type === "response.reasoning_text.done") {
      return;
    }
    if (
      (type === "response.output_item.added" || type === "response.output_item.done") &&
      event?.item?.type === "reasoning"
    ) {
      const collapsed = collapseReasoningItem(event.item);
      if (collapsed !== event.item) {
        this.push(rewrittenBlock(parsed, { ...event, item: collapsed }) + parsed.separator);
        return;
      }
    }
    if (type === "response.completed" && Array.isArray(event?.response?.output)) {
      const output = event.response.output.map(collapseReasoningItem);
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
        payload.output = payload.output.map(collapseReasoningItem);
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
