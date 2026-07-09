import { OPS_UI_HOSTNAME } from "@shared/lib/runtime-origins";
import { buildRequestUrl } from "@/lib/api";
import { RequestFailure, requestTextWithResponse } from "@/lib/request";

export function isOpsUiHost(
  hostname: string | null = typeof window !== "undefined" ? window.location.hostname : null,
): boolean {
  return hostname === OPS_UI_HOSTNAME;
}

export function buildAdminApiPath(path: string): string {
  if (!path.startsWith("/api/")) {
    throw new Error(`Admin API path must start with /api/: ${path}`);
  }
  return `/api/admin${path.slice("/api".length)}`;
}

export interface AdminMutationOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
  timeoutMs?: number | null;
}

export interface AdminMutationResult<T> {
  data: T;
  text: string;
  formattedBody: string;
  status: number;
}

function parseResponseText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatResponseBody(parsed: unknown, text: string): string {
  if (parsed && typeof parsed === "object") {
    return JSON.stringify(parsed, null, 2);
  }
  return text;
}

function getErrorMessage(status: number, parsed: unknown, text: string): string {
  if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
    return parsed.error;
  }
  return `${status}: ${text}`;
}

export async function adminMutation<T = unknown>(
  path: string,
  options: AdminMutationOptions = {},
): Promise<AdminMutationResult<T>> {
  const headers = new Headers(options.headers);
  headers.set("X-Pharos-Admin", "1");
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  let result;
  try {
    result = await requestTextWithResponse(buildRequestUrl(buildAdminApiPath(path)), {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      init: {
        method: options.method ?? "POST",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      },
    });
  } catch (error) {
    if (error instanceof RequestFailure && error.kind === "http" && error.status != null) {
      const text = error.bodyText ?? "";
      throw new Error(getErrorMessage(error.status, parseResponseText(text), text), { cause: error });
    }
    throw error;
  }
  const { response, data: text } = result;
  const parsed = parseResponseText(text);

  return {
    data: parsed as T,
    text,
    formattedBody: formatResponseBody(parsed, text),
    status: response.status,
  };
}

export async function postAdminJson<T>(
  path: string,
  body?: unknown,
  options?: Omit<AdminMutationOptions, "method" | "body">,
): Promise<T> {
  const result = await adminMutation<T>(path, {
    ...options,
    method: "POST",
    body,
  });
  return result.data;
}
