const ENCODER = new TextEncoder();
let cachedSecret: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;

function getKey(secret: string): Promise<CryptoKey> {
  if (cachedSecret !== secret || cachedKey === null) {
    cachedSecret = secret;
    cachedKey = crypto.subtle.importKey(
      "raw",
      ENCODER.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedKey;
}

export async function hashClientIp(ip: string, secret: string): Promise<string> {
  const digest = await crypto.subtle.sign("HMAC", await getKey(secret), ENCODER.encode(ip));
  return Array.from(
    new Uint8Array(digest).slice(0, 16),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
