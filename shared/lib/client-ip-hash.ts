const ENCODER = new TextEncoder();
let cachedSecret: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;

/** One public-limiter subject per IPv4 address or canonical IPv6 /64. */
export function clientAddressLimiterSubject(address: string | null | undefined): string | null {
  const ip = address?.trim() ?? "";
  const octets = ip.split(".");
  if (octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return ip;
  if (!ip.includes(":") || !/^[\da-f:.]+$/i.test(ip)) return null;
  try {
    // URL supplies the platform's IPv6 parser, including embedded dotted IPv4.
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const words = right === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
    const parts = words.map((word) => parseInt(word, 16));
    if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
      return [parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255].join(".");
    }
    const prefix = [...words.slice(0, 4), "0", "0", "0", "0"].join(":");
    return `${new URL(`http://[${prefix}]/`).hostname.slice(1, -1)}/64`;
  } catch {
    return null;
  }
}

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
