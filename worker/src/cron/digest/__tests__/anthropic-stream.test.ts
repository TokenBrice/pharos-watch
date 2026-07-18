import { describe, expect, it } from "vitest";
import { accumulateAnthropicStream } from "../anthropic-stream";

interface SseEvent {
  event: string;
  data: unknown;
}

function sseResponse(events: SseEvent[], opts?: { chunkSplitPattern?: number[] }): Response {
  const encoder = new TextEncoder();
  const encoded = events
    .map((ev) => `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    .join("");
  const chunks: Uint8Array[] = [];
  if (opts?.chunkSplitPattern?.length) {
    let cursor = 0;
    for (const len of opts.chunkSplitPattern) {
      chunks.push(encoder.encode(encoded.slice(cursor, cursor + len)));
      cursor += len;
    }
    if (cursor < encoded.length) {
      chunks.push(encoder.encode(encoded.slice(cursor)));
    }
  } else {
    chunks.push(encoder.encode(encoded));
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function rawSseResponse(encoded: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(encoded));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function happyPathEvents(textChunks: string[]): SseEvent[] {
  return [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    ...textChunks.map((text) => ({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

describe("accumulateAnthropicStream", () => {
  it("concatenates text_delta chunks into the final string", async () => {
    const response = sseResponse(happyPathEvents(["Hello, ", "world", "!"]));
    const text = await accumulateAnthropicStream(response);
    expect(text).toBe("Hello, world!");
  });

  it("handles SSE frames split mid-event across chunks", async () => {
    const events = happyPathEvents(["alpha ", "beta ", "gamma"]);
    // Force chunk boundaries at odd positions so some events span multiple reads.
    const response = sseResponse(events, { chunkSplitPattern: [5, 10, 50, 30, 70, 200, 1] });
    const text = await accumulateAnthropicStream(response);
    expect(text).toBe("alpha beta gamma");
  });

  it("joins multiple data lines in one SSE frame with newlines", async () => {
    const response = rawSseResponse(
      [
        "event: content_block_delta",
        "data: {\"type\":\"content_block_delta\",\"index\":0,",
        "data: \"delta\":{\"type\":\"text_delta\",\"text\":\"split payload\"}}",
        "",
        "event: message_stop",
        "data: {\"type\":\"message_stop\"}",
        "",
        "",
      ].join("\n"),
    );

    const text = await accumulateAnthropicStream(response);
    expect(text).toBe("split payload");
  });

  it("ignores thinking_delta events (extended thinking)", async () => {
    const response = sseResponse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_t" } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "internal reasoning" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "final answer" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const text = await accumulateAnthropicStream(response);
    expect(text).toBe("final answer");
  });

  it("throws when the stream emits an SSE error event", async () => {
    const response = sseResponse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_e" } } },
      { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Anthropic is over capacity" } } },
    ]);
    await expect(accumulateAnthropicStream(response)).rejects.toThrow(/overloaded_error|over capacity/);
  });

  it("cancels the response body when an SSE error exits before EOF", async () => {
    const encoder = new TextEncoder();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "event: error",
              "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Anthropic is over capacity\"}}",
              "",
              "",
            ].join("\n"),
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    const response = new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });

    await expect(accumulateAnthropicStream(response)).rejects.toThrow(/overloaded_error|over capacity/);
    expect(canceled).toBe(true);
  });

  it("throws when the stream ends with no text content", async () => {
    const response = sseResponse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_empty" } } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    await expect(accumulateAnthropicStream(response)).rejects.toThrow(/empty/i);
  });

  it("reports a runaway-thinking max_tokens stop as truncation with token diagnostics", async () => {
    // Runaway thinking consuming the whole budget (stop_reason=max_tokens with
    // no text) now fails via the dedicated truncation guard rather than the
    // generic empty-text error; the stop reason and token count stay visible.
    const response = sseResponse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_mt" } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning..." } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 15999 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const err = await accumulateAnthropicStream(response).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/max_tokens/);
    expect(msg).toMatch(/outputTokens=15999/);
  });

  it("still reports stop reason and delta histograms for a non-truncated empty stream", async () => {
    const response = sseResponse([
      { event: "message_start", data: { type: "message_start", message: { id: "msg_empty2" } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning..." } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const err = await accumulateAnthropicStream(response).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/stopReason=end_turn/);
    expect(msg).toMatch(/thinking_delta/);
  });

  it("throws when the response has no body", async () => {
    const bodiless = new Response(null, { status: 200 });
    await expect(accumulateAnthropicStream(bodiless)).rejects.toThrow(/body/i);
  });
});

describe("max_tokens truncation", () => {
  it("throws when the stream stops at max_tokens instead of returning truncated text", async () => {
    const events: SseEvent[] = [
      { event: "message_start", data: { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"title":"Truncated mid' } },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
    await expect(accumulateAnthropicStream(sseResponse(events))).rejects.toThrow(/max_tokens/);
  });
});
