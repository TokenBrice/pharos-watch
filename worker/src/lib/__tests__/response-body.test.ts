import { describe, expect, it, vi } from "vitest";
import { cancelResponseBodyQuietly, drainResponseBody } from "../response-body";

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
      body: { cancel },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows cancellation errors", async () => {
    const response = {
      body: {
        cancel: vi.fn(async () => {
          throw new Error("cannot cancel");
        }),
      },
    } as unknown as Response;

    await expect(cancelResponseBodyQuietly(response)).resolves.toBeUndefined();
  });
});
