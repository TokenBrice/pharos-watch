// Accumulate the text content from an Anthropic Messages API streaming
// response (server-sent events). Anthropic returns one SSE event per protocol
// step; the text comes from `content_block_delta` events of type `text_delta`.
// Streaming is required on Cloudflare Workers because non-streaming Opus
// requests hold the subrequest open with no bytes for minutes while the model
// thinks, which trips CF's ~130s subrequest idle timeout. Streaming flushes
// headers + ping events early so the subrequest stays alive.
//
// This helper is intentionally tolerant of event types it does not recognize
// (ping, etc.) and surfaces `error` events as thrown exceptions so the caller
// can route to the circuit breaker. When the stream finishes without producing
// any text, the error message includes stop_reason plus a histogram of seen
// events and delta types so the failure is diagnosable without wiring a second
// tail-log probe.
//
// Server-side fallback (`fallbacks: "default"`) can hand a request to another
// model on the same stream. After a mid-output handoff `message_start` still
// names the requested model, so the serving model is read from the `fallback`
// content block and the `usage.iterations` list, which is also the only place
// the declined attempt's billed tokens appear.

interface AnthropicStreamErrorPayload {
  error?: { type?: string; message?: string };
}

interface AnthropicContentBlockDelta {
  delta?: { type?: string; text?: string };
}

interface AnthropicContentBlockStart {
  content_block?: {
    type?: string;
    from?: { model?: string } | null;
    to?: { model?: string } | null;
  };
}

interface AnthropicUsageIterationPayload {
  type?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface AnthropicMessageDelta {
  delta?: {
    stop_reason?: string | null;
    stop_sequence?: string | null;
    stop_details?: AnthropicStopDetails | null;
  };
  usage?: { output_tokens?: number; iterations?: AnthropicUsageIterationPayload[] };
}

interface AnthropicMessageStart {
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
  };
}

export type AnthropicRefusalCategory =
  | "cyber"
  | "bio"
  | "frontier_llm"
  | "reasoning_extraction"
  | "general_harms";

interface AnthropicStopDetails {
  type?: string;
  category?: AnthropicRefusalCategory | null;
}

/** A server-side fallback handoff, marked on the stream by a `fallback` content block. */
export interface AnthropicFallbackHandoff {
  from: string | null;
  to: string;
}

/**
 * One model attempt from `usage.iterations`. With server-side fallback the
 * top-level usage describes only the attempt that produced the returned
 * message; each attempt that ran is billed separately at its own model's rates.
 */
export interface AnthropicUsageIteration {
  type: string | null;
  model: string | null;
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
}

export interface AnthropicStreamResult {
  text: string;
  /** Model that produced the returned message, after any fallback handoff. */
  servedModel: string | null;
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  refusalCategory: AnthropicRefusalCategory | null;
  fallbacks: AnthropicFallbackHandoff[];
  /** Per-attempt usage when the API reports it; null when absent. */
  iterations: AnthropicUsageIteration[] | null;
}

/**
 * - `stream-error`: an SSE `error` event.
 * - `max-tokens`: generation stopped at `max_tokens`.
 * - `incomplete`: the stream ended before `message_stop`, so the text and
 *   usage are partial or missing.
 * - `empty`: the message completed without any text.
 */
export type AnthropicStreamFailureKind = "stream-error" | "max-tokens" | "incomplete" | "empty";

export class AnthropicStreamFailure extends Error {
  constructor(
    message: string,
    readonly result: AnthropicStreamResult,
    readonly kind: AnthropicStreamFailureKind,
  ) {
    super(message);
    this.name = "AnthropicStreamFailure";
  }
}

/**
 * SSE frames end at a blank line. Anthropic emits LF framing, but the spec also
 * permits CRLF and bare CR, so a `\n\n`-only scan silently drops a CRLF stream.
 * Return the earliest complete terminator; an incomplete one (for example a
 * lone trailing `\r`) stays buffered until the next chunk completes it.
 */
const SSE_FRAME_TERMINATORS = ["\r\n\r\n", "\n\n", "\r\r"] as const;

function findFrameTerminator(buffer: string): { index: number; length: number } | null {
  let earliest: { index: number; length: number } | null = null;
  for (const terminator of SSE_FRAME_TERMINATORS) {
    const index = buffer.indexOf(terminator);
    if (index === -1) continue;
    if (earliest == null || index < earliest.index) {
      earliest = { index, length: terminator.length };
    }
  }
  return earliest;
}

export async function accumulateAnthropicStream(response: Response): Promise<AnthropicStreamResult> {
  const body = response.body;
  if (!body) {
    throw new Error("Anthropic stream: response has no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let streamError: Error | null = null;
  let servedModel: string | null = null;
  let inputTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let stopReason: string | null = null;
  let refusalCategory: AnthropicRefusalCategory | null = null;
  let outputTokens: number | null = null;
  const fallbacks: AnthropicFallbackHandoff[] = [];
  let iterations: AnthropicUsageIteration[] | null = null;
  const eventCounts: Record<string, number> = {};
  const deltaTypeCounts: Record<string, number> = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      let terminator: { index: number; length: number } | null;
      while ((terminator = findFrameTerminator(buffer)) != null) {
        const frame = buffer.slice(0, terminator.index);
        buffer = buffer.slice(terminator.index + terminator.length);
        const result = handleFrame(frame);
        if (result.eventType) {
          eventCounts[result.eventType] = (eventCounts[result.eventType] ?? 0) + 1;
        }
        if (result.deltaType) {
          deltaTypeCounts[result.deltaType] = (deltaTypeCounts[result.deltaType] ?? 0) + 1;
        }
        if (result.stopReason) stopReason = result.stopReason;
        if (result.servedModel) servedModel = result.servedModel;
        if (result.inputTokens != null) inputTokens = result.inputTokens;
        if (result.cacheWriteTokens != null) cacheWriteTokens = result.cacheWriteTokens;
        if (result.cacheReadTokens != null) cacheReadTokens = result.cacheReadTokens;
        if (result.outputTokens != null) outputTokens = result.outputTokens;
        if (result.refusalCategory !== undefined) refusalCategory = result.refusalCategory;
        if (result.fallback) {
          fallbacks.push(result.fallback);
          servedModel = result.fallback.to;
        }
        if (result.iterations) iterations = result.iterations;
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

  // The iteration that served the turn is the authoritative serving model; it
  // agrees with the last `fallback` block when both are present.
  const servingIteration = iterations ? [...iterations].reverse().find((iteration) => iteration.type === "fallback_message") : undefined;
  if (servingIteration?.model) servedModel = servingIteration.model;

  const result: AnthropicStreamResult = {
    text: accumulated,
    servedModel,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    stopReason,
    refusalCategory,
    fallbacks,
    iterations,
  };

  if (streamError) throw new AnthropicStreamFailure(streamError.message, result, "stream-error");

  // Anthropic documents stop_details on the streamed message_delta alongside
  // stop_reason. A refusal can arrive before output or after partial output;
  // either way the partial text must be discarded rather than parsed.
  if (stopReason === "refusal") {
    return { ...result, text: "" };
  }

  // A max_tokens stop means the output was cut mid-stream. Truncated JSON
  // must fail here rather than flow into the parser's raw-text fallback.
  if (stopReason === "max_tokens") {
    throw new AnthropicStreamFailure(
      `Anthropic stream: response truncated at max_tokens (outputTokens=${outputTokens ?? "null"}, accumulatedChars=${accumulated.length})`,
      result,
      "max-tokens",
    );
  }

  // EOF before both the final message_delta and message_stop: the connection
  // ended mid-generation. The text is a fragment and the billed usage is
  // unknown, so it must neither be parsed nor treated as a free attempt.
  if (stopReason === null && eventCounts.message_stop === undefined) {
    throw new AnthropicStreamFailure(
      `Anthropic stream: ended before message_stop (accumulatedChars=${accumulated.length}, events=${JSON.stringify(eventCounts)})`,
      result,
      "incomplete",
    );
  }

  if (!accumulated) {
    const detail = [
      `stopReason=${stopReason ?? "null"}`,
      `outputTokens=${outputTokens ?? "null"}`,
      `events=${JSON.stringify(eventCounts)}`,
      `deltaTypes=${JSON.stringify(deltaTypeCounts)}`,
    ].join(", ");
    throw new AnthropicStreamFailure(`Anthropic stream: empty text content after message_stop (${detail})`, result, "empty");
  }
  return result;
}

interface FrameResult {
  text?: string;
  error?: Error;
  eventType?: string;
  deltaType?: string;
  stopReason?: string;
  servedModel?: string;
  inputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  refusalCategory?: AnthropicRefusalCategory | null;
  fallback?: AnthropicFallbackHandoff;
  iterations?: AnthropicUsageIteration[];
}

function handleFrame(frame: string): FrameResult {
  if (!frame.trim()) return {};
  let eventType: string | null = null;
  let dataStr: string | null = null;
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataStr = dataStr == null ? value : `${dataStr}\n${value}`;
    }
  }
  if (!eventType || dataStr == null) return {};

  const out: FrameResult = { eventType };

  if (eventType === "message_start") {
    let parsed: AnthropicMessageStart;
    try {
      parsed = JSON.parse(dataStr) as AnthropicMessageStart;
    } catch {
      return out;
    }
    if (typeof parsed.message?.model === "string") out.servedModel = parsed.message.model;
    if (typeof parsed.message?.usage?.input_tokens === "number") {
      out.inputTokens = parsed.message.usage.input_tokens;
    }
    if (typeof parsed.message?.usage?.cache_creation_input_tokens === "number") {
      out.cacheWriteTokens = parsed.message.usage.cache_creation_input_tokens;
    }
    if (typeof parsed.message?.usage?.cache_read_input_tokens === "number") {
      out.cacheReadTokens = parsed.message.usage.cache_read_input_tokens;
    }
    return out;
  }

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

  if (eventType === "content_block_start") {
    let parsed: AnthropicContentBlockStart;
    try {
      parsed = JSON.parse(dataStr) as AnthropicContentBlockStart;
    } catch {
      return out;
    }
    const block = parsed.content_block;
    if (block?.type === "fallback" && typeof block.to?.model === "string") {
      out.fallback = {
        from: typeof block.from?.model === "string" ? block.from.model : null,
        to: block.to.model,
      };
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
    if (parsed.delta?.stop_details?.type === "refusal") {
      out.refusalCategory = parsed.delta.stop_details.category ?? null;
    }
    if (typeof parsed.usage?.output_tokens === "number") out.outputTokens = parsed.usage.output_tokens;
    if (Array.isArray(parsed.usage?.iterations)) {
      out.iterations = parsed.usage.iterations.map((iteration) => ({
        type: typeof iteration.type === "string" ? iteration.type : null,
        model: typeof iteration.model === "string" ? iteration.model : null,
        inputTokens: typeof iteration.input_tokens === "number" ? iteration.input_tokens : null,
        cacheWriteTokens: typeof iteration.cache_creation_input_tokens === "number" ? iteration.cache_creation_input_tokens : null,
        cacheReadTokens: typeof iteration.cache_read_input_tokens === "number" ? iteration.cache_read_input_tokens : null,
        outputTokens: typeof iteration.output_tokens === "number" ? iteration.output_tokens : null,
      }));
    }
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
