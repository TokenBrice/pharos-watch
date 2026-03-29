/**
 * Cloudflare Access JWT verification using Web Crypto API.
 *
 * Verifies JWT signatures against the JWKS endpoint published by
 * Cloudflare Access, then validates standard claims (aud, exp, iss).
 *
 * JWKS keys are cached in-memory with a 1-hour TTL to avoid
 * fetching on every request.
 */

export interface JwtVerifyOptions {
  token: string;
  aud: string; // Application AUD from Access settings
  teamDomain: string; // e.g., "pharos" for pharos.cloudflareaccess.com
}

interface JwksKey {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
  use?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

interface JwtHeader {
  kid: string;
  alg: string;
  typ?: string;
}

interface JwtPayload {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  iat?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  type?: string;
}

// ── In-memory JWKS cache ────────────────────────────────────────────
interface CachedJwksEntry {
  jwks: JwksResponse;
  expiresAt: number;
}

const jwksCache = new Map<string, CachedJwksEntry>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Visible for testing — resets the in-memory JWKS cache for all domains. */
export function _resetJwksCache(): void {
  jwksCache.clear();
}

// ── Base64url helpers ───────────────────────────────────────────────

function base64urlDecode(input: string): Uint8Array {
  // Convert base64url to standard base64
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  // Pad to multiple of 4
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJsonPart<T>(part: string): T | null {
  try {
    const decoded = base64urlDecode(part);
    const text = new TextDecoder().decode(decoded);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ── JWKS fetching ───────────────────────────────────────────────────

async function fetchJwks(
  teamDomain: string,
  options: { forceRefresh?: boolean } = {},
): Promise<JwksResponse | null> {
  const now = Date.now();
  const cached = jwksCache.get(teamDomain);
  if (!options.forceRefresh && cached && now < cached.expiresAt) {
    return cached.jwks;
  }

  try {
    const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const jwks = (await response.json()) as JwksResponse;
    if (!jwks.keys || !Array.isArray(jwks.keys)) return null;

    jwksCache.set(teamDomain, {
      jwks,
      expiresAt: now + JWKS_CACHE_TTL_MS,
    });
    return jwks;
  } catch {
    return null;
  }
}

// ── Key import ──────────────────────────────────────────────────────

function importAlgorithm(alg: string): { name: string; hash: string } | null {
  // Cloudflare Access uses RS256
  switch (alg) {
    case "RS256":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    case "RS384":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };
    case "RS512":
      return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" };
    default:
      return null;
  }
}

async function importPublicKey(jwk: JwksKey): Promise<CryptoKey | null> {
  const algorithm = importAlgorithm(jwk.alg);
  if (!algorithm) return null;

  try {
    return await crypto.subtle.importKey(
      "jwk",
      {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        alg: jwk.alg,
        use: jwk.use ?? "sig",
      },
      algorithm,
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

// ── Main verification ───────────────────────────────────────────────

/**
 * Verify a Cloudflare Access JWT.
 *
 * Returns `true` if the JWT signature is valid and all claims pass
 * validation. Returns `false` (never throws) for any failure.
 */
export async function verifyAccessJwt(options: JwtVerifyOptions): Promise<boolean> {
  const { token, aud, teamDomain } = options;

  // ── 1. Split and decode ───────────────────────────────────────
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJsonPart<JwtHeader>(headerB64);
  if (!header?.kid || !header.alg) return false;

  const payload = decodeJsonPart<JwtPayload>(payloadB64);
  if (!payload) return false;

  // ── 2. Validate claims before expensive crypto ────────────────
  // Expiry
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return false;

  // Not-before (if present)
  if (typeof payload.nbf === "number" && payload.nbf > now) return false;

  // Audience — may be a string or array
  const audValues = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
  if (!audValues.includes(aud)) return false;

  // Issuer
  const expectedIssuer = `https://${teamDomain}.cloudflareaccess.com`;
  if (payload.iss !== expectedIssuer) return false;

  // ── 3. Fetch JWKS and find matching key ───────────────────────
  let jwks = await fetchJwks(teamDomain);
  if (!jwks) return false;

  let matchingKey = jwks.keys.find((k) => k.kid === header.kid);
  if (!matchingKey) {
    // Cloudflare Access can rotate signing keys before the local cache TTL elapses.
    // Retry once with a forced refetch before failing closed.
    jwks = await fetchJwks(teamDomain, { forceRefresh: true });
    if (!jwks) return false;
    matchingKey = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!matchingKey) return false;

  // ── 4. Import key and verify signature ────────────────────────
  const cryptoKey = await importPublicKey(matchingKey);
  if (!cryptoKey) return false;

  const algorithm = importAlgorithm(header.alg);
  if (!algorithm) return false;

  try {
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64urlDecode(signatureB64);

    return await crypto.subtle.verify(algorithm.name, cryptoKey, signature, signingInput);
  } catch {
    return false;
  }
}
