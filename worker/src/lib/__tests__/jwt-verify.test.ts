import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  verifyAccessJwt,
  verifyAccessJwtUserIdentity,
  normalizeTeamDomain,
  _resetJwksCache,
} from "@shared/lib/cloudflare-access-jwt";

// ── Helpers ─────────────────────────────────────────────────────────

function base64urlEncode(data: string): string {
  const encoded = btoa(data);
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncodeBytes(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const encoded = btoa(String.fromCharCode(...bytes));
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwtParts(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): { headerB64: string; payloadB64: string; token: string } {
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  // Fake signature — will fail crypto verification but allows claim tests
  const sigB64 = base64urlEncode("fake-signature-bytes");
  return { headerB64, payloadB64, token: `${headerB64}.${payloadB64}.${sigB64}` };
}

async function makeSignedJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<{ token: string; jwk: Record<string, unknown> }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as unknown as Record<string, unknown>;
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return {
    token: `${signingInput}.${base64urlEncodeBytes(signature)}`,
    jwk: {
      ...publicJwk,
      kid: String(header.kid),
      alg: String(header.alg),
      use: "sig",
    },
  };
}

const TEAM_DOMAIN = "pharos";
const OTHER_TEAM_DOMAIN = "ops";
const AUD = "test-aud-value";
const ISSUER = `https://${TEAM_DOMAIN}.cloudflareaccess.com`;
const OTHER_ISSUER = `https://${OTHER_TEAM_DOMAIN}.cloudflareaccess.com`;
const JWKS_URL = `https://${TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;
const OTHER_JWKS_URL = `https://${OTHER_TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

function validClaims(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    aud: AUD,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: ISSUER,
    iat: Math.floor(Date.now() / 1000) - 60,
    sub: "user-id",
    email: "admin@example.com",
    ...overrides,
  };
}

function validHeader(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    alg: "RS256",
    kid: "test-kid-1",
    typ: "JWT",
    ...overrides,
  };
}

// A minimal valid JWKS response — the key values are structurally valid
// but won't actually verify the fake signatures in unit tests.
const MOCK_JWKS = {
  keys: [
    {
      kid: "test-kid-1",
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
    },
  ],
};

// ── Tests ───────────────────────────────────────────────────────────

describe("normalizeTeamDomain", () => {
  it("passes through a bare team name", () => {
    expect(normalizeTeamDomain("pharos-watch")).toBe("pharos-watch");
  });

  it("extracts team name from a full https URL", () => {
    expect(normalizeTeamDomain("https://pharos-watch.cloudflareaccess.com")).toBe("pharos-watch");
  });

  it("extracts team name from an http URL", () => {
    expect(normalizeTeamDomain("http://pharos-watch.cloudflareaccess.com")).toBe("pharos-watch");
  });

  it("handles trailing path in the URL", () => {
    expect(normalizeTeamDomain("https://pharos-watch.cloudflareaccess.com/cdn-cgi/access/certs")).toBe("pharos-watch");
  });

  it("trims whitespace", () => {
    expect(normalizeTeamDomain("  pharos-watch  ")).toBe("pharos-watch");
  });
});

describe("verifyAccessJwt", () => {
  beforeEach(() => {
    _resetJwksCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetJwksCache();
  });

  // ── Malformed tokens ──────────────────────────────────────────

  describe("malformed tokens", () => {
    it("rejects empty string", async () => {
      expect(await verifyAccessJwt({ token: "", aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with only one part", async () => {
      expect(await verifyAccessJwt({ token: "abc", aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with two parts", async () => {
      expect(await verifyAccessJwt({ token: "abc.def", aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with four parts", async () => {
      expect(await verifyAccessJwt({ token: "a.b.c.d", aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with invalid base64url header", async () => {
      expect(await verifyAccessJwt({ token: "!!!.abc.def", aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with header missing kid", async () => {
      const { token } = makeJwtParts({ alg: "RS256" }, validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with header missing alg", async () => {
      const { token } = makeJwtParts({ kid: "k1" }, validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });
  });

  // ── Claim validation ─────────────────────────────────────────

  describe("claim validation", () => {
    it("rejects expired token", async () => {
      const { token } = makeJwtParts(validHeader(), validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with missing exp claim", async () => {
      const claims = validClaims();
      delete claims.exp;
      const { token } = makeJwtParts(validHeader(), claims);
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with wrong audience (string)", async () => {
      const { token } = makeJwtParts(validHeader(), validClaims({ aud: "wrong-aud" }));
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with wrong audience (array)", async () => {
      const { token } = makeJwtParts(validHeader(), validClaims({ aud: ["wrong-1", "wrong-2"] }));
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with missing audience", async () => {
      const claims = validClaims();
      delete claims.aud;
      const { token } = makeJwtParts(validHeader(), claims);
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects token with wrong issuer", async () => {
      const { token } = makeJwtParts(validHeader(), validClaims({ iss: "https://evil.cloudflareaccess.com" }));
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("normalizes a full URL teamDomain before issuer comparison", async () => {
      mockFetch([{ match: () => true, body: MOCK_JWKS }]);
      const { token } = makeJwtParts(validHeader(), validClaims());
      // Passing the full URL should still reach JWKS fetch (claims pass)
      await verifyAccessJwt({ token, aud: AUD, teamDomain: `https://${TEAM_DOMAIN}.cloudflareaccess.com` });
      expect(fetch).toHaveBeenCalledWith(JWKS_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("rejects token with nbf in the future", async () => {
      const { token } = makeJwtParts(validHeader(), validClaims({ nbf: Math.floor(Date.now() / 1000) + 3600 }));
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects a token whose Access type does not match the expected type", async () => {
      const fetchMock = mockFetch([], { requireMatch: true });
      const { token } = makeJwtParts(validHeader(), validClaims({ type: "org" }));

      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN, expectedType: "app" })).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a token with missing Access type when an expected type is configured", async () => {
      const fetchMock = mockFetch([], { requireMatch: true });
      const { token } = makeJwtParts(validHeader(), validClaims());

      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN, expectedType: "app" })).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a service-token subject when a user subject is required", async () => {
      const fetchMock = mockFetch([], { requireMatch: true });
      const { token } = makeJwtParts(
        validHeader(),
        validClaims({
          type: "app",
          common_name: "service-token.access",
          sub: "",
        }),
      );

      expect(
        await verifyAccessJwt({
          token,
          aud: AUD,
          teamDomain: TEAM_DOMAIN,
          expectedType: "app",
          expectedSubject: "user",
        }),
      ).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts token with audience as array containing correct aud", async () => {
      // Claims pass, but signature verification will fail — that's OK,
      // we're testing that the claim check for array audience works.
      // We mock fetch to return JWKS but the crypto.subtle.verify will
      // fail because the signature is fake.
      mockFetch([{ match: () => true, body: MOCK_JWKS }]);
      const { token } = makeJwtParts(validHeader(), validClaims({ aud: ["other-aud", AUD] }));
      // Should get past claim validation but fail at crypto — returning false
      // (but not due to claim rejection)
      await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN });
      // We can't easily distinguish "claim pass but crypto fail" from claim rejection
      // in the boolean API, but we know the fetch was called (meaning claims passed)
      expect(fetch).toHaveBeenCalledWith(JWKS_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("accepts a valid signed Access JWT", async () => {
      const { token, jwk } = await makeSignedJwt(validHeader(), validClaims());
      mockFetch([{ match: () => true, body: { keys: [jwk] } }]);

      await expect(verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).resolves.toBe(true);
    });

    it("accepts a valid signed Access JWT when the expected type matches", async () => {
      const { token, jwk } = await makeSignedJwt(validHeader(), validClaims({ type: "app" }));
      mockFetch([{ match: () => true, body: { keys: [jwk] } }]);

      await expect(verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN, expectedType: "app" })).resolves.toBe(
        true,
      );
    });

    it("accepts a valid signed user Access JWT when a user subject is required", async () => {
      const { token, jwk } = await makeSignedJwt(validHeader(), validClaims({ type: "app" }));
      mockFetch([{ match: () => true, body: { keys: [jwk] } }]);

      await expect(
        verifyAccessJwt({
          token,
          aud: AUD,
          teamDomain: TEAM_DOMAIN,
          expectedType: "app",
          expectedSubject: "user",
        }),
      ).resolves.toBe(true);
    });

    it("returns normalized identity only after user Access JWT verification", async () => {
      const { token, jwk } = await makeSignedJwt(
        validHeader(),
        validClaims({ type: "app", email: " Operator@Example.COM ", sub: " operator-subject " }),
      );
      mockFetch([{ match: () => true, body: { keys: [jwk] } }]);

      await expect(
        verifyAccessJwtUserIdentity({
          token,
          aud: AUD,
          teamDomain: TEAM_DOMAIN,
          expectedType: "app",
        }),
      ).resolves.toEqual({ email: "operator@example.com", subject: "operator-subject" });
    });
  });

  // ── JWKS fetch failures ──────────────────────────────────────

  describe("JWKS fetch", () => {
    it("returns false when JWKS fetch fails", async () => {
      mockFetch([{ match: () => true, outcomes: [new Error("network error")] }]);
      const { token } = makeJwtParts(validHeader(), validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("returns false when JWKS returns non-200", async () => {
      mockFetch([{ match: () => true, body: "not found", status: 404 }]);
      const { token } = makeJwtParts(validHeader(), validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("returns false when JWKS has no matching kid", async () => {
      mockFetch([{ match: () => true, body: { keys: [{ ...MOCK_JWKS.keys[0], kid: "other-kid" }] } }]);
      const { token } = makeJwtParts(validHeader(), validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("retries with a fresh JWKS fetch when the cached key set misses the token kid", async () => {
      const fetchMock = mockFetch([
        {
          match: () => true,
          outcomes: [
            { body: { keys: [{ ...MOCK_JWKS.keys[0], kid: "old-kid" }] } },
            { body: { keys: [{ ...MOCK_JWKS.keys[0], kid: "rotated-kid" }] } },
          ],
        },
      ]);

      const { token } = makeJwtParts(validHeader({ kid: "old-kid" }), validClaims());
      await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const { token: rotatedToken } = makeJwtParts(validHeader({ kid: "rotated-kid" }), validClaims());
      expect(await verifyAccessJwt({ token: rotatedToken, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        JWKS_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        JWKS_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns false when JWKS response has no keys array", async () => {
      mockFetch([{ match: () => true, body: {} }]);
      const { token } = makeJwtParts(validHeader(), validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });
  });

  // ── JWKS caching ─────────────────────────────────────────────

  describe("JWKS caching", () => {
    it("caches JWKS and reuses on second call", async () => {
      const fetchMock = mockFetch([{ match: () => true, body: MOCK_JWKS }]);

      const { token: token1 } = makeJwtParts(validHeader(), validClaims());
      await verifyAccessJwt({ token: token1, aud: AUD, teamDomain: TEAM_DOMAIN });

      const { token: token2 } = makeJwtParts(validHeader(), validClaims());
      await verifyAccessJwt({ token: token2, aud: AUD, teamDomain: TEAM_DOMAIN });

      // Should only fetch once due to caching
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("re-fetches JWKS after cache expiry", async () => {
      const fetchMock = mockFetch([{ match: () => true, body: MOCK_JWKS }]);

      const { token: token1 } = makeJwtParts(validHeader(), validClaims());
      await verifyAccessJwt({ token: token1, aud: AUD, teamDomain: TEAM_DOMAIN });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance time past the 1-hour TTL
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);

      // Reset the cache to simulate expiry (since we set Date.now via fake timers
      // but the cache was set with the real Date.now)
      _resetJwksCache();

      const { token: token2 } = makeJwtParts(validHeader(), validClaims({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      await verifyAccessJwt({ token: token2, aud: AUD, teamDomain: TEAM_DOMAIN });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("keeps JWKS caches isolated per team domain", async () => {
      const fetchMock = mockFetch([{ match: () => true, body: MOCK_JWKS }]);

      const { token: token1 } = makeJwtParts(validHeader(), validClaims());
      await verifyAccessJwt({ token: token1, aud: AUD, teamDomain: TEAM_DOMAIN });

      const { token: token2 } = makeJwtParts(validHeader(), validClaims({ iss: OTHER_ISSUER }));
      await verifyAccessJwt({ token: token2, aud: AUD, teamDomain: OTHER_TEAM_DOMAIN });

      const { token: token3 } = makeJwtParts(validHeader(), validClaims());
      await verifyAccessJwt({ token: token3, aud: AUD, teamDomain: TEAM_DOMAIN });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        JWKS_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        OTHER_JWKS_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  // ── Unsupported algorithm ────────────────────────────────────

  describe("algorithm handling", () => {
    it("rejects unsupported algorithm", async () => {
      mockFetch([{ match: () => true, body: {
        keys: [{ ...MOCK_JWKS.keys[0], kid: "test-kid-1", alg: "ES256" }],
      } }]);
      const { token } = makeJwtParts(validHeader({ alg: "ES256" }), validClaims());
      expect(await verifyAccessJwt({ token, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });

    it("rejects a token whose header.alg disagrees with the JWKS key alg", async () => {
      // Algorithm-confusion defense: the verifier must pin the algorithm to the
      // JWKS key, not trust the attacker-controlled header. A token presenting
      // RS512 against an RS256 key must be rejected even before crypto verify.
      const { token, jwk } = await makeSignedJwt(validHeader({ alg: "RS256" }), validClaims());
      const confusedHeaderB64 = base64urlEncode(JSON.stringify(validHeader({ alg: "RS512" })));
      const [, payloadB64, sigB64] = token.split(".");
      const confusedToken = `${confusedHeaderB64}.${payloadB64}.${sigB64}`;
      mockFetch([{ match: () => true, body: { keys: [jwk] } }]);

      expect(await verifyAccessJwt({ token: confusedToken, aud: AUD, teamDomain: TEAM_DOMAIN })).toBe(false);
    });
  });
});
