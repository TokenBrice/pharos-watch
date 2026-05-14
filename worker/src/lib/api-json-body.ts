import type { ZodIssue, ZodType } from "zod";
import { errorResponse, type JsonResponseOptions } from "./api-response";

export interface RequestJsonSchemaOptions {
  invalidJsonMessage?: string;
  formatSchemaError?: (issues: readonly ZodIssue[]) => string;
  responseOptions?: JsonResponseOptions;
}

export async function parseRequestJsonWithSchema<T>(
  request: Request,
  schema: ZodType<T>,
  options: RequestJsonSchemaOptions = {},
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
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
