import { OPS_UI_HOSTNAME } from "@shared/lib/runtime-origins";
import { buildRequestUrl } from "@/lib/api";

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

function getErrorMessage(response: Response, parsed: unknown, text: string): string {
  if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
    return parsed.error;
  }
  return `${response.status}: ${text}`;
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

  const response = await fetch(buildRequestUrl(buildAdminApiPath(path)), {
    method: options.method ?? "POST",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const parsed = parseResponseText(text);

  if (!response.ok) {
    throw new Error(getErrorMessage(response, parsed, text));
  }

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
