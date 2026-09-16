import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetJwksCache, verifyAccessJwt } from "../cloudflare-access-jwt";

const TEAM_DOMAIN = "pharos-test";
const AUDIENCE = "admin-audience";
const ISSUER = `https://${TEAM_DOMAIN}.cloudflareaccess.com`;
const NOW_SECONDS = 2_000_000_000;

let signingPair: CryptoKeyPair;
let publicJwk: JsonWebKey;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: "RS256", kid: "access-key", typ: "JWT" });
  const claims = encodeJson(payload);
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(new Uint8Array(signature)).toString("base64url")}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: AUDIENCE,
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 60,
    iss: ISSUER,
    sub: "operator-1",
    email: "operator@example.com",
    ...overrides,
  };
}

beforeAll(async () => {
  signingPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  publicJwk = await crypto.subtle.exportKey("jwk", signingPair.publicKey);
  vi.spyOn(Date, "now").mockReturnValue(NOW_SECONDS * 1000);
});

beforeEach(() => {
  _resetJwksCache();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    keys: [{ ...publicJwk, kid: "access-key", alg: "RS256", use: "sig" }],
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
});

afterAll(() => {
  _resetJwksCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("verifyAccessJwt", () => {
  it("accepts a correctly signed Access token", async () => {
    const token = await signToken(validClaims());

    await expect(verifyAccessJwt({ token, aud: AUDIENCE, teamDomain: TEAM_DOMAIN })).resolves.toBe(true);
  });

  it.each([
    ["expired", { exp: NOW_SECONDS }],
    ["for another audience", { aud: "other-audience" }],
    ["from another issuer", { iss: "https://other.cloudflareaccess.com" }],
  ])("rejects a correctly signed token that is %s", async (_label, overrides) => {
    const token = await signToken(validClaims(overrides));

    await expect(verifyAccessJwt({ token, aud: AUDIENCE, teamDomain: TEAM_DOMAIN })).resolves.toBe(false);
  });
});
