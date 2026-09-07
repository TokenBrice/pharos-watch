import { afterEach, describe, expect, it, vi } from "vitest";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import {
  DONOR_CLAIM_SIWE_DOMAIN,
  DONOR_CLAIM_SIWE_URI,
  buildDonorClaimSiweMessage,
} from "@shared/lib/donor-key-claim";
import { DONOR_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { DonorKeyClaimError, claimDonorKey, hexUtf8 } from "../donor-key-claim-client";

const ADDRESS = "0xAa7A9d80971e58641442774C373C94AAFEe87d66";
const SIGNATURE = `0x${"ab".repeat(65)}`;

function issuedPayload(): Record<string, unknown> {
  return {
    status: "issued",
    token: "ak_live_donor_secret",
    key: {
      keyPrefix: "ak_live",
      maskedToken: "ak_live_****",
      tier: "donor",
      rateLimitPerMinute: DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: null,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hexUtf8", () => {
  it("hex-encodes UTF-8 bytes with a 0x prefix", () => {
    expect(hexUtf8("abc")).toBe("0x616263");
  });

  it("pads bytes below 0x10 so the hex length stays even", () => {
    expect(hexUtf8("\n")).toBe("0x0a");
  });

  it("encodes multi-byte characters as their UTF-8 bytes", () => {
    // "é" is two bytes in UTF-8; a charCode-based encoder would emit "0xe9".
    expect(hexUtf8("é")).toBe("0xc3a9");
  });

  it("round-trips a signed claim message through TextDecoder", () => {
    const message = buildDonorClaimSiweMessage({
      address: ADDRESS,
      nonce: "abcd1234abcd1234",
      issuedAt: new Date("2026-09-07T12:00:00.000Z"),
    });
    const bytes = Uint8Array.from(
      hexUtf8(message).slice(2).match(/.{2}/g) ?? [],
      (pair) => Number.parseInt(pair, 16),
    );

    expect(new TextDecoder().decode(bytes)).toBe(message);
  });
});

describe("buildDonorClaimSiweMessage as the page builds it", () => {
  it("binds the domain, URI, address, nonce, and a five-minute window", () => {
    const issuedAt = new Date("2026-09-07T12:00:00.000Z");
    const message = buildDonorClaimSiweMessage({ address: ADDRESS, nonce: "abcd1234abcd1234", issuedAt });

    expect(message.startsWith(`${DONOR_CLAIM_SIWE_DOMAIN} wants you to sign in with your Ethereum account:\n${ADDRESS}\n`)).toBe(true);
    expect(message).toContain(`URI: ${DONOR_CLAIM_SIWE_URI}`);
    expect(message).toContain("Nonce: abcd1234abcd1234");
    expect(message).toContain("Issued At: 2026-09-07T12:00:00.000Z");
    expect(message).toContain("Expiration Time: 2026-09-07T12:05:00.000Z");
  });
});

describe("claimDonorKey", () => {
  it("posts the signed message and returns the issued key", async () => {
    const body = issuedPayload();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body, 201));

    await expect(claimDonorKey({ message: "siwe", signature: SIGNATURE })).resolves.toEqual(body);

    const [path, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(path)).toContain("/api/donor-key-claims");
    expect(new Headers((init as RequestInit | undefined)?.headers).get("Accept")).toContain(PHAROS_WEB_ACCEPT_MARKER);
    expect((init as RequestInit | undefined)?.method).toBe("POST");
  });

  it("surfaces the ledger timestamp from a 403 ineligible body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "Wallet is not eligible.", ledgerUpdatedAt: 1788681300 }, 403),
    );

    await expect(claimDonorKey({ message: "siwe", signature: SIGNATURE })).rejects.toMatchObject({
      name: "DonorKeyClaimError",
      status: 403,
      message: "Wallet is not eligible.",
      ledgerUpdatedAt: 1788681300,
    });
  });

  it("keeps the status for error bodies without a ledger timestamp", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ error: "Already claimed." }, 409));

    const rejection = await claimDonorKey({ message: "siwe", signature: SIGNATURE }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(DonorKeyClaimError);
    expect(rejection).toMatchObject({ status: 409, message: "Already claimed.", ledgerUpdatedAt: null });
  });

  it("falls back to a status message when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("gateway down", { status: 503 }));

    await expect(claimDonorKey({ message: "siwe", signature: SIGNATURE })).rejects.toMatchObject({
      status: 503,
      message: "Request failed with status 503",
    });
  });

  it("rejects a success body that does not match the response contract", async () => {
    const payload = issuedPayload();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ...payload, key: { ...(payload.key as Record<string, unknown>), expiresAt: 123 } }, 201),
    );

    await expect(claimDonorKey({ message: "siwe", signature: SIGNATURE })).rejects.toThrow();
  });
});
