import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Exchanges the service-account JSON file at `keyPath` for an OAuth access token with `scope`.
 * Errors name the HTTP status only, never the key or token.
 * @param {string} keyPath
 * @param {string} scope
 * @param {string} label Product name used in error messages, such as "GA4".
 * @returns {Promise<string>}
 */
export async function serviceAccountAccessToken(keyPath, scope, label) {
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    // A JSON syntax error quotes its input, which here is key material.
    credentials = null;
  }
  if (!credentials?.client_email || !credentials.private_key) throw new Error("GOOGLE_APPLICATION_CREDENTIALS must name a service-account JSON file with client_email and private_key");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credentials.client_email,
    scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}`,
  }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${label} service-account token exchange failed (HTTP ${response.status})`);
  const token = await response.json();
  if (typeof token.access_token !== "string") throw new Error(`${label} token exchange returned no access_token`);
  return token.access_token;
}
