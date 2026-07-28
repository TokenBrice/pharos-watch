import { describe, expect, it, vi } from "vitest";
import {
  cancelResponseBodyQuietly,
  cancelUnsuccessfulResponseBodyQuietly,
  drainResponseBody,
  readResponseTextBoundedWithSignal,
  readResponseTextWithinLimitWithSignal,
} from "../response-body";

describe("drainResponseBody", () => {
  it("returns without touching responses that are already consumed", async () => {
    const response = new Response("ok");
    await response.text();

    await expect(drainResponseBody(response)).resolves.toBeUndefined();
  });

  it("cancels the stream when arrayBuffer consumption fails", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      bodyUsed: false,
      body: { cancel },
      arrayBuffer: vi.fn(async () => {
        throw new Error("stream failed");
      }),
    } as unknown as Response;

    await expect(drainResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows cancellation failures after a read failure", async () => {
    const response = {
      bodyUsed: false,
      body: {
        cancel: vi.fn(async () => {
          throw new Error("already cancelled");
        }),
      },
      arrayBuffer: vi.fn(async () => {
        throw new Error("stream failed");
      }),
    } as unknown as Response;

    await expect(drainResponseBody(response)).resolves.toBeUndefined();
  });
});

describe("cancelResponseBodyQuietly", () => {
  it("returns for nullish responses", async () => {
    await expect(cancelResponseBodyQuietly(null)).resolves.toBeUndefined();
    await expect(cancelResponseBodyQuietly(undefined)).resolves.toBeUndefined();
  });

  it("cancels the body when present", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      bodyUsed: false,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel responses whose body has already been consumed", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      bodyUsed: true,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("swallows cancellation errors", async () => {
    const response = {
      bodyUsed: false,
      body: {
        cancel: vi.fn(async () => {
          throw new Error("cannot cancel");
        }),
      },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
  });
});

describe("cancelUnsuccessfulResponseBodyQuietly", () => {
  it("does not cancel successful responses", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: true,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelUnsuccessfulResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels non-OK responses", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: false,
      body: { cancel },
    } as unknown as Response;

    await expect(cancelUnsuccessfulResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("readResponseTextWithinLimitWithSignal", () => {
  it("throws when the declared content length exceeds the strict limit", async () => {
    const response = new Response("abcdef", {
      headers: { "Content-Length": "6" },
    });

    await expect(readResponseTextWithinLimitWithSignal(response, 5)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError",
      maxBytes: 5,
      observedBytes: 6,
    });
  });

  it("throws when the streamed body exceeds the strict limit", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextWithinLimitWithSignal(response, 5)).rejects.toMatchObject({
      name: "ResponseBodyTooLargeError",
      maxBytes: 5,
      observedBytes: 6,
    });
  });
});

describe("readResponseTextBoundedWithSignal", () => {
  it("returns a truncated diagnostic body instead of throwing", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextBoundedWithSignal(response, 3)).resolves.toBe("abc");
  });

  it("returns an empty diagnostic body for a zero-byte limit", async () => {
    const response = new Response("abcdef");

    await expect(readResponseTextBoundedWithSignal(response, 0)).resolves.toBe("");
  });
});
