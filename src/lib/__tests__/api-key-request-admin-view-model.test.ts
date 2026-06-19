import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiKeyRequestIdempotencyKey } from "../api-key-request-admin-view-model";

const originalCrypto = globalThis.crypto;

function setCrypto(value: Crypto | undefined) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value,
  });
}

describe("createApiKeyRequestIdempotencyKey", () => {
  afterEach(() => {
    setCrypto(originalCrypto);
  });

  it("uses crypto.randomUUID when available", () => {
    setCrypto({
      randomUUID: vi.fn(() => "uuid-from-runtime"),
    } as unknown as Crypto);

    expect(createApiKeyRequestIdempotencyKey("reject", "akr_demo")).toBe(
      "api-key-request:reject:akr_demo:uuid-from-runtime",
    );
  });

  it("falls back to getRandomValues for supported browsers without randomUUID", () => {
    setCrypto({
      getRandomValues: vi.fn((array: Uint8Array) => {
        array.set([
          0x00,
          0x11,
          0x22,
          0x33,
          0x44,
          0x55,
          0x66,
          0x77,
          0x88,
          0x99,
          0xaa,
          0xbb,
          0xcc,
          0xdd,
          0xee,
          0xff,
        ]);
        return array;
      }),
    } as unknown as Crypto);

    expect(createApiKeyRequestIdempotencyKey("release-claim", "akr_demo")).toBe(
      "api-key-request:release-claim:akr_demo:00112233-4455-4677-8899-aabbccddeeff",
    );
  });

  it("throws when Web Crypto is unavailable", () => {
    setCrypto(undefined);

    expect(() => createApiKeyRequestIdempotencyKey("reject", "akr_demo")).toThrow(
      "Web Crypto is required to generate a collision-resistant idempotency key",
    );
  });
});
