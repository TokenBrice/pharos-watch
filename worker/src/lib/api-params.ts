import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { errorResponse } from "./api-response";
import { base64UrlToBytes, bytesToBase64Url } from "@shared/lib/base64url";

export type NumericRangePolicy = "clamp" | "reject";

export interface NumericParseOptions {
  rangePolicy?: NumericRangePolicy;
}

export interface ParamSpec extends NumericParseOptions {
  type: "int" | "float";
  default: number;
  min: number;
  max: number;
  name?: string;
}

interface ClampedIntegerParamOptions {
  zeroAsDefault?: boolean;
}

interface OptionalPositiveIntegerParamOptions {
  max?: number;
}

type JsonCursorValidator<T> = (payload: unknown) => T | null;

function rejectOutOfRange(name: string, min: number, max: number): Response {
  return errorResponse(400, `Invalid ${name}: must be between ${min} and ${max}`);
}

function applyRangePolicy(
  parsed: number,
  min: number,
  max: number,
  name: string,
  rangePolicy: NumericRangePolicy,
): number | Response {
  if (rangePolicy === "reject" && (parsed < min || parsed > max)) {
    return rejectOutOfRange(name, min, max);
  }
  return Math.min(max, Math.max(min, parsed));
}

export function resolveOrReject(id: string): { canonicalId: string } | Response {
  const resolved = resolveStablecoinId(id);
  if (!resolved) {
    return errorResponse(404, "Unknown stablecoin");
  }
  return { canonicalId: resolved.canonicalId };
}

export function parseBooleanParam(
  value: string | null | undefined,
  name: string,
  defaultValue: boolean,
): boolean | Response {
  if (value == null || value === "") return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return errorResponse(400, `Invalid ${name}: must be true or false`);
}

export function parseBooleanInput(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

export function readBodyOrQueryParam(
  body: Record<string, unknown>,
  searchParams: URLSearchParams,
  key: string,
): unknown {
  return body[key] ?? searchParams.get(key);
}

export function readBodyOrQueryStringParam(
  body: Record<string, unknown>,
  searchParams: URLSearchParams,
  key: string,
): string | null {
  const bodyValue = body[key];
  const value = typeof bodyValue === "string" ? bodyValue : searchParams.get(key);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function encodeJsonCursor(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64Url(bytes);
}

function decodeJsonCursorPayload(value: string): unknown | null {
  try {
    const bytes = base64UrlToBytes(value);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export function parseJsonCursorParam<T>(
  value: string | null | undefined,
  validate: JsonCursorValidator<T>,
  message = "Invalid cursor: malformed cursor",
): T | null | Response {
  if (!value) return null;
  const payload = decodeJsonCursorPayload(value);
  if (payload == null) return errorResponse(400, message);
  try {
    return validate(payload) ?? errorResponse(400, message);
  } catch {
    return errorResponse(400, message);
  }
}

export function parseIntParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
  name = "parameter",
  options?: NumericParseOptions,
): number | Response {
  if (value == null) return defaultVal;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  return applyRangePolicy(parsed, min, max, name, options?.rangePolicy ?? "clamp");
}

export function parseClampedIntegerParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
  options?: ClampedIntegerParamOptions,
): number {
  const trimmed = value?.trim();
  const parsed = trimmed == null || !/^-?\d+$/.test(trimmed) ? defaultVal : Number.parseInt(trimmed, 10);
  const normalized =
    !Number.isFinite(parsed) || (options?.zeroAsDefault === true && parsed === 0) ? defaultVal : Math.floor(parsed);
  return Math.max(min, Math.min(max, normalized));
}

export function parseOptionalNonNegativeIntegerParam(
  value: string | null | undefined,
  defaultVal: number,
  fieldName = "parameter",
): number | Response {
  if (value == null || value.trim().length === 0) return defaultVal;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return errorResponse(400, `Invalid ${fieldName}: must be a non-negative integer`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return errorResponse(400, `Invalid ${fieldName}: must be a non-negative integer`);
  }
  return parsed;
}

export function parseOptionalPositiveIntegerParam(
  value: string | null | undefined,
  fieldName = "parameter",
  options?: OptionalPositiveIntegerParamOptions,
): number | Response | null {
  if (value == null || value.trim().length === 0) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return errorResponse(400, `Invalid ${fieldName}: must be a positive integer`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return errorResponse(400, `Invalid ${fieldName}: must be a positive integer`);
  }
  return options?.max != null ? Math.min(parsed, options.max) : parsed;
}

export function parseFloatParam(
  value: string | null | undefined,
  defaultVal: number,
  min: number,
  max: number,
  name = "parameter",
  options?: NumericParseOptions,
): number | Response {
  if (value == null) return defaultVal;
  const trimmed = value.trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    return errorResponse(400, `Invalid ${name}: must be a number`);
  }
  return applyRangePolicy(parsed, min, max, name, options?.rangePolicy ?? "clamp");
}

export function parseQueryParams<T extends Record<string, ParamSpec>>(
  searchParams: URLSearchParams,
  specs: T,
): { [K in keyof T]: number } | Response {
  const result = {} as { [K in keyof T]: number };
  for (const [key, spec] of Object.entries(specs) as [keyof T & string, ParamSpec][]) {
    const parser = spec.type === "int" ? parseIntParam : parseFloatParam;
    const value = parser(searchParams.get(key), spec.default, spec.min, spec.max, spec.name ?? key, {
      rangePolicy: spec.rangePolicy,
    });
    if (value instanceof Response) return value;
    result[key] = value;
  }
  return result;
}

export function parseOptionalEnumParam<T extends string>(
  value: string | null | undefined,
  validValues: ReadonlySet<T>,
  name: string,
): T | null | Response {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!validValues.has(trimmed as T)) {
    return errorResponse(400, `Invalid ${name} parameter`);
  }
  return trimmed as T;
}

export function parseEnumParam<T extends string>(
  value: string | null | undefined,
  validValues: ReadonlySet<T>,
  name: string,
  defaultValue: T,
): T | Response {
  const parsed = parseOptionalEnumParam(value, validValues, name);
  if (parsed instanceof Response) {
    return parsed;
  }
  return parsed ?? defaultValue;
}

export function parseRequiredStablecoinIdParam(searchParams: URLSearchParams, name = "stablecoin"): string | Response {
  const stablecoinId = searchParams.get(name);
  if (!stablecoinId) {
    return errorResponse(400, `Missing required parameter: ${name}`);
  }

  const resolved = resolveOrReject(stablecoinId);
  if (resolved instanceof Response) {
    return resolved;
  }

  return resolved.canonicalId;
}

export function parseTimestampSecondsParam(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    return numeric >= 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return null;
  return Math.floor(parsedMs / 1000);
}

export function parseDayStartParam(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    const seconds = numeric > 1_000_000_000_000 ? Math.floor(numeric / 1000) : numeric;
    return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return null;
  return Math.floor(parsedMs / 1000 / DAY_SECONDS) * DAY_SECONDS;
}
