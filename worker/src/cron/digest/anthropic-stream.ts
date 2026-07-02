// Accumulate the text content from an Anthropic Messages API streaming
// response (server-sent events). Anthropic returns one SSE event per protocol
// step; we only care about `content_block_delta` events of type `text_delta`.
// Streaming is required on Cloudflare Workers because non-streaming Opus 4.7
// requests hold the subrequest open with no bytes for minutes while the model
// thinks, which trips CF's ~130s subrequest idle timeout. Streaming flushes
// headers + ping events early so the subrequest stays alive.
//
// This helper is intentionally tolerant of event types it does not recognize
// (ping, message_start, etc.) and surfaces `error` events as thrown exceptions
// so the caller can route to the circuit breaker. When the stream finishes
// without producing any text, the error message includes stop_reason plus a
// histogram of seen events and delta types so the failure is diagnosable
// without wiring a second tail-log probe.

interface AnthropicStreamErrorPayload {
  error?: { type?: string; message?: string };
}

interface AnthropicContentBlockDelta {
  delta?: { type?: string; text?: string };
}

interface AnthropicMessageDelta {
  delta?: { stop_reason?: string | null; stop_sequence?: string | null };
  usage?: { output_tokens?: number };
}

export async function accumulateAnthropicStream(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    throw new Error("Anthropic stream: response has no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let streamError: Error | null = null;
  let stopReason: string | null = null;
  let outputTokens: number | null = null;
  const eventCounts: Record<string, number> = {};
  const deltaTypeCounts: Record<string, number> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      // An SSE event is terminated by a blank line (\n\n). Any tail without a
      // terminator stays in the buffer for the next chunk.
      let separatorIdx: number;
      while ((separatorIdx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        const result = handleFrame(frame);
        if (result.eventType) {
          eventCounts[result.eventType] = (eventCounts[result.eventType] ?? 0) + 1;
        }
        if (result.deltaType) {
          deltaTypeCounts[result.deltaType] = (deltaTypeCounts[result.deltaType] ?? 0) + 1;
        }
        if (result.stopReason) stopReason = result.stopReason;
        if (result.outputTokens != null) outputTokens = result.outputTokens;
        if (result.error) {
          streamError = result.error;
          break;
        }
        if (result.text) accumulated += result.text;
      }
      if (streamError) break;
      if (done) break;
    }
  } finally {
    if (streamError) {
      await reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released if the stream errored.
    }
  }

  if (streamError) throw streamError;

  if (!accumulated) {
    const detail = [
      `stopReason=${stopReason ?? "null"}`,
      `outputTokens=${outputTokens ?? "null"}`,
      `events=${JSON.stringify(eventCounts)}`,
      `deltaTypes=${JSON.stringify(deltaTypeCounts)}`,
    ].join(", ");
    throw new Error(`Anthropic stream: empty text content after message_stop (${detail})`);
  }
  return accumulated;
}

interface FrameResult {
  text?: string;
  error?: Error;
  eventType?: string;
  deltaType?: string;
  stopReason?: string;
  outputTokens?: number;
}

function handleFrame(frame: string): FrameResult {
  if (!frame.trim()) return {};
  let eventType: string | null = null;
  let dataStr: string | null = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataStr = dataStr == null ? value : `${dataStr}\n${value}`;
    }
  }
  if (!eventType || dataStr == null) return {};

  const out: FrameResult = { eventType };

  if (eventType === "content_block_delta") {
    let parsed: AnthropicContentBlockDelta;
    try {
      parsed = JSON.parse(dataStr) as AnthropicContentBlockDelta;
    } catch {
      return out;
    }
    if (parsed.delta?.type) out.deltaType = parsed.delta.type;
    if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
      out.text = parsed.delta.text;
    }
    return out;
  }

  if (eventType === "message_delta") {
    let parsed: AnthropicMessageDelta;
    try {
      parsed = JSON.parse(dataStr) as AnthropicMessageDelta;
    } catch {
      return out;
    }
    if (parsed.delta?.stop_reason) out.stopReason = parsed.delta.stop_reason;
    if (typeof parsed.usage?.output_tokens === "number") out.outputTokens = parsed.usage.output_tokens;
    return out;
  }

  if (eventType === "error") {
    let parsed: AnthropicStreamErrorPayload;
    try {
      parsed = JSON.parse(dataStr) as AnthropicStreamErrorPayload;
    } catch {
      out.error = new Error("Anthropic stream error (unparseable payload)");
      return out;
    }
    const msg = parsed.error?.message ?? "unknown";
    const type = parsed.error?.type ?? "error";
    out.error = new Error(`Anthropic stream error (${type}): ${msg}`);
    return out;
  }

  return out;
}
