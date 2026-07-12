import type { ZodIssue, ZodType } from "zod";
import { errorResponse, type JsonResponseOptions } from "./api-response";

export interface RequestJsonSchemaOptions {
  invalidJsonMessage?: string;
  bodyTooLargeMessage?: string;
  formatSchemaError?: (issues: readonly ZodIssue[]) => string;
  responseOptions?: JsonResponseOptions;
  maxBytes?: number;
}

export const DEFAULT_REQUEST_JSON_MAX_BYTES = 128 * 1024;
export const DEFAULT_ADMIN_REQUEST_JSON_MAX_BYTES = DEFAULT_REQUEST_JSON_MAX_BYTES;

function contentLengthExceedsCap(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength == null) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > maxBytes;
}

export async function readRequestTextBounded(
  request: Request,
  maxBytes: number,
  options: Pick<RequestJsonSchemaOptions, "invalidJsonMessage" | "bodyTooLargeMessage" | "responseOptions"> = {},
): Promise<string | Response> {
  if (contentLengthExceedsCap(request, maxBytes)) {
    return errorResponse(413, options.bodyTooLargeMessage ?? "Request body too large", options.responseOptions);
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // A cloned request body is a tee. Awaiting cancellation can block until
        // the other branch is consumed, but the caller still needs that branch.
        void reader.cancel().catch(() => undefined);
        return errorResponse(413, options.bodyTooLargeMessage ?? "Request body too large", options.responseOptions);
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, options.invalidJsonMessage ?? "Invalid JSON body", options.responseOptions);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function parseRequestJsonWithSchema<T>(
  request: Request,
  schema: ZodType<T>,
  options: RequestJsonSchemaOptions = {},
): Promise<T | Response> {
  let raw: unknown;
  try {
    const text = await readRequestTextBounded(request, options.maxBytes ?? DEFAULT_REQUEST_JSON_MAX_BYTES, options);
    if (text instanceof Response) return text;
    raw = JSON.parse(text);
  } catch {
    return errorResponse(400, options.invalidJsonMessage ?? "Invalid JSON body", options.responseOptions);
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  return errorResponse(
    400,
    options.formatSchemaError?.(parsed.error.issues) ?? parsed.error.issues[0]?.message ?? "Invalid JSON body",
    options.responseOptions,
  );
}

export async function parseOptionalRequestJsonObject(request?: Request): Promise<Record<string, unknown> | Response> {
  if (!request || request.method !== "POST") return {};

  const rawBody = await readRequestTextBounded(request.clone(), DEFAULT_ADMIN_REQUEST_JSON_MAX_BYTES);
  if (rawBody instanceof Response) return rawBody;
  if (!rawBody.trim()) return {};

  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse(400, "Invalid JSON body");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
}
