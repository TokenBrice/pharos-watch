import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";
import { errorResponse } from "./api-response";

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
  const parsed = value == null ? defaultVal : Number(value);
  const normalized = !Number.isFinite(parsed) || (options?.zeroAsDefault === true && parsed === 0)
    ? defaultVal
    : Math.floor(parsed);
  return Math.max(min, Math.min(max, normalized));
}

export function parseOptionalNonNegativeIntegerParam(
  value: string | null | undefined,
  defaultVal: number,
): number {
  if (value != null) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return defaultVal;
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
    const value = parser(
      searchParams.get(key),
      spec.default,
      spec.min,
      spec.max,
      spec.name ?? key,
      { rangePolicy: spec.rangePolicy },
    );
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

export function parseRequiredStablecoinIdParam(
  searchParams: URLSearchParams,
  name = "stablecoin",
): string | Response {
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
