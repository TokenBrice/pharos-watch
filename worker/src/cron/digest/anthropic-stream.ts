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
// so the caller can route to the circuit breaker.

interface AnthropicStreamErrorPayload {
  error?: { type?: string; message?: string };
}

interface AnthropicContentBlockDelta {
  delta?: { type?: string; text?: string };
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
        const delta = handleFrame(frame);
        if (delta.error) {
          streamError = delta.error;
          break;
        }
        if (delta.text) accumulated += delta.text;
      }
      if (streamError) break;
      if (done) break;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released if the stream errored.
    }
  }

  if (streamError) throw streamError;

  if (!accumulated) {
    throw new Error("Anthropic stream: empty text content after message_stop");
  }
  return accumulated;
}

interface FrameResult {
  text?: string;
  error?: Error;
}

function handleFrame(frame: string): FrameResult {
  if (!frame.trim()) return {};
  let eventType: string | null = null;
  let dataStr: string | null = null;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const existing: string = dataStr ?? "";
      dataStr = existing + line.slice(5).trim();
    }
  }
  if (!eventType || dataStr == null) return {};

  if (eventType === "content_block_delta") {
    let parsed: AnthropicContentBlockDelta;
    try {
      parsed = JSON.parse(dataStr) as AnthropicContentBlockDelta;
    } catch {
      return {};
    }
    if (parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
      return { text: parsed.delta.text };
    }
    return {};
  }

  if (eventType === "error") {
    let parsed: AnthropicStreamErrorPayload;
    try {
      parsed = JSON.parse(dataStr) as AnthropicStreamErrorPayload;
    } catch {
      return { error: new Error("Anthropic stream error (unparseable payload)") };
    }
    const msg = parsed.error?.message ?? "unknown";
    const type = parsed.error?.type ?? "error";
    return { error: new Error(`Anthropic stream error (${type}): ${msg}`) };
  }

  return {};
}
