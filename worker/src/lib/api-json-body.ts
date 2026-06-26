import type { ZodIssue, ZodType } from "zod";
import { errorResponse, type JsonResponseOptions } from "./api-response";

export interface RequestJsonSchemaOptions {
  invalidJsonMessage?: string;
  bodyTooLargeMessage?: string;
  formatSchemaError?: (issues: readonly ZodIssue[]) => string;
  responseOptions?: JsonResponseOptions;
  maxBytes?: number;
}

function contentLengthExceedsCap(request: Request, maxBytes: number): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength == null) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > maxBytes;
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
  options: RequestJsonSchemaOptions,
): Promise<string | Response> {
  if (contentLengthExceedsCap(request, maxBytes)) {
    return errorResponse(
      413,
      options.bodyTooLargeMessage ?? "Request body too large",
      options.responseOptions,
    );
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
        await reader.cancel().catch(() => undefined);
        return errorResponse(
          413,
          options.bodyTooLargeMessage ?? "Request body too large",
          options.responseOptions,
        );
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(
      400,
      options.invalidJsonMessage ?? "Invalid JSON body",
      options.responseOptions,
    );
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
    if (options.maxBytes == null) {
      raw = await request.json();
    } else {
      const text = await readBoundedRequestText(request, options.maxBytes, options);
      if (text instanceof Response) return text;
      raw = JSON.parse(text);
    }
  } catch {
    return errorResponse(
      400,
      options.invalidJsonMessage ?? "Invalid JSON body",
      options.responseOptions,
    );
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  return errorResponse(
    400,
    options.formatSchemaError?.(parsed.error.issues)
      ?? parsed.error.issues[0]?.message
      ?? "Invalid JSON body",
    options.responseOptions,
  );
}

export async function parseOptionalRequestJsonObject(
  request?: Request,
): Promise<Record<string, unknown> | Response> {
  if (!request || request.method !== "POST") return {};

  const rawBody = await request.clone().text();
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
