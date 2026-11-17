import { createHash, createHmac } from "node:crypto";

const REGION = "auto";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

type FetchLike = typeof fetch;

export interface R2ObjectClientOptions {
  bucket: string;
  accessKeyEnv: string;
  secretKeyEnv: string;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export interface R2ObjectMetadata {
  etag: string | null;
  contentLength: number | null;
  contentType: string | null;
  customMetadata: Record<string, string>;
}

export interface R2PutOptions {
  contentType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
  ifNoneMatch?: "*";
}

export interface R2ObjectClient {
  put(key: string, body: Uint8Array, options?: R2PutOptions): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<R2ObjectMetadata | null>;
}

export class R2ObjectExistsError extends Error {
  constructor(key: string) {
    super(`R2 object already exists: ${key}`);
    this.name = "R2ObjectExistsError";
  }
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** AWS SigV4 (RFC 3986) encoding of one path segment or query component. */
function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** AWS SigV4 URI encoding with slash preservation for an object key. */
function encodePath(value: string): string {
  return value.split("/").map(encodeComponent).join("/");
}

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'" };
function xmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => XML_ENTITIES[entity]!);
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[ \t]+/gu, " ");
}

function formatAmzDate(date: Date): { short: string; full: string } {
  if (!Number.isFinite(date.getTime())) throw new Error("R2 request date is invalid");
  const iso = date.toISOString().replace(/[-:]|\.\d{3}/gu, "");
  const normalized = iso.endsWith("Z") ? iso.slice(0, -1) : iso;
  return { short: normalized.slice(0, 8), full: `${normalized.slice(0, 15)}Z` };
}

function assertObjectKey(key: string): string {
  if (!key || key !== key.trim() || key.startsWith("/") || key.includes("\\")
    || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("R2 object key must be a relative path");
  }
  return key;
}

function requireCredential(name: string, explicit: string | undefined): string {
  const value = (explicit ?? process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing ${name} for R2`);
  return value;
}

/** Path-style SigV4 transport with no delete surface or redirect forwarding. */
export class SignedR2ObjectClient implements R2ObjectClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly host: string;

  constructor(private readonly options: R2ObjectClientOptions) {
    const accountId = requireCredential("CLOUDFLARE_ACCOUNT_ID", options.accountId);
    if (!/^[a-zA-Z0-9-]+$/.test(accountId)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID for R2");
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(options.bucket)) throw new Error("Invalid R2 bucket name");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.host = `${accountId}.r2.cloudflarestorage.com`;
  }

  async put(key: string, body: Uint8Array, options: R2PutOptions = {}): Promise<void> {
    const response = await this.request("PUT", key, body, options);
    await response.body?.cancel();
    if (response.status === 412 && options.ifNoneMatch === "*") throw new R2ObjectExistsError(key);
    if (!response.ok) throw new Error(`R2 PUT ${key} returned HTTP ${response.status}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const response = await this.request("GET", key, new Uint8Array(), {});
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      throw new Error(`R2 GET ${key} returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async head(key: string): Promise<R2ObjectMetadata | null> {
    const response = await this.request("HEAD", key, new Uint8Array(), {});
    await response.body?.cancel();
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 HEAD ${key} returned HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    const parsedLength = length === null ? null : Number(length);
    const customMetadata: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name.startsWith("x-amz-meta-")) customMetadata[name.slice("x-amz-meta-".length)] = value;
    });
    return {
      etag: response.headers.get("etag"),
      contentLength: parsedLength !== null && Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null,
      contentType: response.headers.get("content-type"),
      customMetadata,
    };
  }

  /** Every key under `prefix` (ListObjectsV2), following continuation pages. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuation: string | undefined;
    do {
      const response = await this.request("GET", null, new Uint8Array(), {}, {
        "list-type": "2", prefix, ...(continuation === undefined ? {} : { "continuation-token": continuation }),
      });
      const xml = await response.text();
      if (!response.ok) throw new Error(`R2 LIST ${prefix} returned HTTP ${response.status}`);
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/gu)) keys.push(xmlText(match[1]));
      continuation = /<IsTruncated>true<\/IsTruncated>/u.test(xml)
        ? xmlText(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u.exec(xml)?.[1] ?? "")
        : undefined;
      if (continuation === "") throw new Error(`R2 LIST ${prefix} was truncated without a continuation token`);
    } while (continuation !== undefined);
    return keys;
  }

  private async request(method: "PUT" | "GET" | "HEAD", key: string | null, body: Uint8Array, options: R2PutOptions, query: Record<string, string> = {}): Promise<Response> {
    const objectPath = key === null ? "" : `/${encodePath(assertObjectKey(key))}`;
    const accessKeyId = requireCredential(this.options.accessKeyEnv, this.options.accessKeyId);
    const secretAccessKey = requireCredential(this.options.secretKeyEnv, this.options.secretAccessKey);
    const payloadHash = method === "PUT" ? createHash("sha256").update(body).digest("hex") : EMPTY_SHA256;
    const { short, full } = formatAmzDate(this.now());
    const canonicalUri = `/${this.options.bucket}${objectPath}`;
    const canonicalQuery = Object.keys(query).sort().map((name) => `${encodeComponent(name)}=${encodeComponent(query[name]!)}`).join("&");
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": full,
    };
    if (method === "PUT") {
      if (options.contentType) headers["content-type"] = options.contentType;
      if (options.contentEncoding) headers["content-encoding"] = options.contentEncoding;
      if (options.cacheControl) headers["cache-control"] = options.cacheControl;
      if (options.ifNoneMatch) headers["if-none-match"] = options.ifNoneMatch;
      for (const [name, value] of Object.entries(options.customMetadata ?? {})) {
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid R2 metadata name: ${name}`);
        headers[`x-amz-meta-${name}`] = value;
      }
    }
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((name) => `${name}:${canonicalHeaderValue(headers[name]!)}\n`).join("");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(";"), payloadHash].join("\n");
    const scope = `${short}/${REGION}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", full, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
    const dateKey = hmac(`AWS4${secretAccessKey}`, short);
    const regionKey = hmac(dateKey, REGION);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${createHmac("sha256", signingKey).update(stringToSign).digest("hex")}`;
    return this.fetchImpl(`https://${this.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
      method, headers, redirect: "error",
      ...(method === "PUT" ? { body: Buffer.from(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength) } : {}),
    });
  }
}
