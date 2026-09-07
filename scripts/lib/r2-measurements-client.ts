import { createHash, createHmac } from "node:crypto";

export const R2_MEASUREMENTS_BUCKET = "pharos-measurements";
export const R2_MEASUREMENTS_REGION = "auto";
export const R2_MEASUREMENTS_ACCESS_KEY_ENV = "R2_MEASUREMENTS_ACCESS_KEY_ID";
export const R2_MEASUREMENTS_SECRET_KEY_ENV = "R2_MEASUREMENTS_SECRET_ACCESS_KEY";
export const R2_MEASUREMENTS_ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

type FetchLike = typeof fetch;

export interface R2MeasurementsClientOptions {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export interface R2MeasurementsObjectMetadata {
  etag: string | null;
  contentLength: number | null;
  contentType: string | null;
}

export interface R2MeasurementsClient {
  put(key: string, body: Uint8Array, options?: { contentType?: string; contentEncoding?: string }): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<R2MeasurementsObjectMetadata | null>;
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** AWS SigV4 URI encoding with slash preservation for an object key. */
function encodePath(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[ \t]+/gu, " ");
}

function formatAmzDate(date: Date): { short: string; full: string } {
  if (!Number.isFinite(date.getTime())) throw new Error("R2 measurements request date is invalid");
  const iso = date.toISOString().replace(/[-:]|\.\d{3}/gu, "");
  const normalized = iso.endsWith("Z") ? iso.slice(0, -1) : iso;
  return { short: normalized.slice(0, 8), full: `${normalized.slice(0, 15)}Z` };
}

function assertObjectKey(key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("R2 measurements object key must be a relative path");
  }
  return normalized;
}

function requireCredential(name: string, explicit: string | undefined): string {
  const value = (explicit ?? process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing ${name} for R2 measurements`);
  return value;
}

/**
 * Minimal path-style R2 S3 client. R2's S3-compatible endpoint accepts the
 * standard SigV4 `auto` region; this deliberately exposes only PUT/GET/HEAD so
 * measurement retention cannot accidentally gain delete/list semantics.
 */
export class SignedR2MeasurementsClient implements R2MeasurementsClient {
  private readonly accountId: string;
  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly host: string;

  constructor(options: R2MeasurementsClientOptions = {}) {
    this.accountId = (options.accountId ?? process.env[R2_MEASUREMENTS_ACCOUNT_ENV] ?? "").trim();
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    if (!this.accountId) throw new Error(`Missing ${R2_MEASUREMENTS_ACCOUNT_ENV} for R2 measurements`);
    this.host = `${this.accountId}.r2.cloudflarestorage.com`;
  }

  async put(
    key: string,
    body: Uint8Array,
    options: { contentType?: string; contentEncoding?: string } = {},
  ): Promise<void> {
    const response = await this.request("PUT", key, body, options);
    if (!response.ok) throw new Error(`R2 PUT ${key} returned HTTP ${response.status}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.request("GET", key, new Uint8Array(), {});
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 GET ${key} returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async head(key: string): Promise<R2MeasurementsObjectMetadata | null> {
    const response = await this.request("HEAD", key, new Uint8Array(), {});
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 HEAD ${key} returned HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    const parsedLength = length === null ? null : Number(length);
    return {
      etag: response.headers.get("etag"),
      contentLength: parsedLength !== null && Number.isSafeInteger(parsedLength) ? parsedLength : null,
      contentType: response.headers.get("content-type"),
    };
  }

  private async request(
    method: "PUT" | "GET" | "HEAD",
    key: string,
    body: Uint8Array,
    options: { contentType?: string; contentEncoding?: string },
  ): Promise<Response> {
    const normalizedKey = assertObjectKey(key);
    const accessKeyId = requireCredential(R2_MEASUREMENTS_ACCESS_KEY_ENV, this.accessKeyId);
    const secretAccessKey = requireCredential(R2_MEASUREMENTS_SECRET_KEY_ENV, this.secretAccessKey);
    const payloadHash = method === "PUT" ? sha256(body) : EMPTY_SHA256;
    const { short, full } = formatAmzDate(this.now());
    const canonicalUri = `/${R2_MEASUREMENTS_BUCKET}/${encodePath(normalizedKey)}`;
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": full,
    };
    if (method === "PUT" && options.contentType) headers["content-type"] = options.contentType;
    if (method === "PUT" && options.contentEncoding) headers["content-encoding"] = options.contentEncoding;
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((name) => `${name}:${canonicalHeaderValue(headers[name]!)}\n`).join("");
    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${short}/${R2_MEASUREMENTS_REGION}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      full,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = hmac(`AWS4${secretAccessKey}`, short);
    const regionKey = hmac(dateKey, R2_MEASUREMENTS_REGION);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;

    return this.fetchImpl(`https://${this.host}${canonicalUri}`, {
      method,
      headers,
      ...(method === "PUT" ? { body: Buffer.from(body) } : {}),
    });
  }
}

export function createR2MeasurementsClient(options: R2MeasurementsClientOptions = {}): SignedR2MeasurementsClient {
  return new SignedR2MeasurementsClient(options);
}
