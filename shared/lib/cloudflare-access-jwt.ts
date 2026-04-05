/**
 * Cloudflare Access JWT verification using Web Crypto API.
 *
 * This module is runtime-neutral: it depends only on Web Platform APIs
 * available in both Worker and Pages runtimes.
 */

export interface JwtVerifyOptions {
  token: string;
  aud: string;
  teamDomain: string;
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

interface CachedJwksEntry {
  jwks: JwksResponse;
  expiresAt: number;
}

const jwksCache = new Map<string, CachedJwksEntry>();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

export function _resetJwksCache(): void {
  jwksCache.clear();
}

function base64urlDecode(input: string): Uint8Array {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
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
    const response = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
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

function importAlgorithm(alg: string): { name: string; hash: string } | null {
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

/**
 * Extracts the bare team name from a CF Access team domain value.
 *
 * Accepts either the bare name ("pharos-watch") or a full URL
 * ("https://pharos-watch.cloudflareaccess.com") and normalizes to just
 * the team name. This guards against misconfiguration where someone
 * pastes the full issuer URL into CF_ACCESS_TEAM_DOMAIN.
 */
export function normalizeTeamDomain(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(
    /^https?:\/\/([^.]+)\.cloudflareaccess\.com/,
  );
  return match ? match[1] : trimmed;
}

export async function verifyAccessJwt(options: JwtVerifyOptions): Promise<boolean> {
  const { token, aud } = options;
  const teamDomain = normalizeTeamDomain(options.teamDomain);

  const parts = token.split(".");
  if (parts.length !== 3) return false;

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJsonPart<JwtHeader>(headerB64);
  if (!header?.kid || !header.alg) return false;

  const payload = decodeJsonPart<JwtPayload>(payloadB64);
  if (!payload) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now) return false;

  const audValues = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
  if (!audValues.includes(aud)) return false;

  const expectedIssuer = `https://${teamDomain}.cloudflareaccess.com`;
  if (payload.iss !== expectedIssuer) return false;

  let jwks = await fetchJwks(teamDomain);
  if (!jwks) return false;

  let matchingKey = jwks.keys.find((k) => k.kid === header.kid);
  if (!matchingKey) {
    jwks = await fetchJwks(teamDomain, { forceRefresh: true });
    if (!jwks) return false;
    matchingKey = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!matchingKey) return false;

  const cryptoKey = await importPublicKey(matchingKey);
  if (!cryptoKey) return false;

  const algorithm = importAlgorithm(header.alg);
  if (!algorithm) return false;

  try {
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64urlDecode(signatureB64);
    return await crypto.subtle.verify(
      algorithm.name,
      cryptoKey,
      signature as BufferSource,
      signingInput as BufferSource,
    );
  } catch {
    return false;
  }
}
