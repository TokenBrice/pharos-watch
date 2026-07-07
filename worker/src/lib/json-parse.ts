import { toErrorMessage } from "./error-utils";

export interface JsonParseFailure {
  context?: string;
  message: string;
}

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

interface JsonParseOptions {
  context?: string;
  onFailure?: (failure: JsonParseFailure) => void;
}

function resolveOptions(contextOrOptions?: string | JsonParseOptions): JsonParseOptions {
  return typeof contextOrOptions === "string"
    ? { context: contextOrOptions }
    : contextOrOptions ?? {};
}

function recordFailure(options: JsonParseOptions, message: string): void {
  if (options.onFailure) {
    options.onFailure({ context: options.context, message });
    return;
  }
  if (options.context) {
    console.warn(`[json-parse] Failed to parse JSON (${options.context}):`, message);
  }
}

export function parseJson(
  value: string | null | undefined,
  contextOrOptions?: string | JsonParseOptions,
): JsonParseResult {
  if (value == null) {
    return { ok: false, message: "missing JSON value" };
  }

  const options = resolveOptions(contextOrOptions);
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch (error) {
    const message = toErrorMessage(error);
    recordFailure(options, message);
    return { ok: false, message };
  }
}

export function tryParseJson(
  value: string | null | undefined,
  contextOrOptions?: string | JsonParseOptions,
): unknown | null {
  const parsed = parseJson(value, contextOrOptions);
  return parsed.ok ? parsed.value : null;
}

export function parseJsonStringArray(
  value: string | null | undefined,
  contextOrOptions?: string | JsonParseOptions,
  fallback: string[] = [],
): string[] {
  if (!value) return fallback;
  const parsed = parseJson(value, contextOrOptions);
  if (!parsed.ok || !Array.isArray(parsed.value)) return fallback;
  return parsed.value.filter((entry): entry is string => typeof entry === "string");
}

export function parseJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  value: string | null | undefined,
  contextOrOptions?: string | JsonParseOptions,
  fallback: T | null = null,
): T | null {
  if (!value) return fallback;
  const parsed = parseJson(value, contextOrOptions);
  if (
    !parsed.ok ||
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    return fallback;
  }
  return parsed.value as T;
}
