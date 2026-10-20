/**
 * Pure URL <-> typed-state codec. Substrate for future consumers (screener,
 * saved queries, watchlists). Platform-agnostic: no `window`, no DOM, no
 * storage access — strings in, strings + typed objects out.
 *
 * Reuses the per-kind parsing primitives from `url-storage-codecs.ts` for
 * decoding; encoding handles default-omission and alphabetical key order
 * inline since the existing primitives only cover the read direction.
 */

import {
  parseBooleanSearchParam,
  parseBoundedNumberSearchParam,
  parseEnumSearchParam,
  parseStringSearchParam,
  toSearchParams,
  type SearchInput,
} from "@/lib/url-storage-codecs";

type UrlStateFieldVariants<V> =
  | {
      kind: "enum";
      defaultValue: V;
      allowedValues: readonly V[];
      normalize?: (value: string) => string;
      encode?: (value: V) => string;
    }
  | {
      kind: "boundedNumber";
      defaultValue: V;
      min?: number;
      max?: number;
      integer?: boolean;
    }
  | {
      kind: "string";
      defaultValue: V;
      trim?: boolean;
    }
  | {
      kind: "boolean";
      defaultValue: V;
    }
  | {
      kind: "enumList";
      defaultValue: V;
      allowedValues?: readonly (V extends readonly unknown[] ? V[number] : never)[];
      delimiter?: string;
      maxItems?: number;
      normalizeItem?: (value: string) => (V extends readonly unknown[] ? V[number] : never) | null;
    };

export type UrlStateField<V> = { defaultValue: V } & (
  [V] extends [string] ? Extract<UrlStateFieldVariants<V>, { kind: "string" | "enum" }>
    : [V] extends [number] ? Extract<UrlStateFieldVariants<V>, { kind: "boundedNumber" }>
    : [V] extends [boolean] ? Extract<UrlStateFieldVariants<V>, { kind: "boolean" }>
    : [V] extends [readonly unknown[]] ? Extract<UrlStateFieldVariants<V>, { kind: "enumList" }>
    : never
);

type DecodedField = UrlStateField<string> | UrlStateField<number>
  | UrlStateField<boolean> | UrlStateField<readonly unknown[]>;

export type UrlStateSchema<T> = { [K in keyof T]: UrlStateField<T[K]> };

function decodeField(
  params: URLSearchParams,
  key: string,
  field: DecodedField,
): string | number | boolean | readonly unknown[] {
  switch (field.kind) {
    case "enum": {
      const result = parseEnumSearchParam(
        params,
        key,
        field.allowedValues,
        { normalize: field.normalize },
      );
      return result ?? field.defaultValue;
    }
    case "boundedNumber": {
      const result = parseBoundedNumberSearchParam(params, key, {
        min: field.min,
        max: field.max,
        integer: field.integer,
      });
      return result ?? field.defaultValue;
    }
    case "string": {
      const result = parseStringSearchParam(params, key, {
        trim: field.trim,
      });
      return result ?? field.defaultValue;
    }
    case "boolean":
      return parseBooleanSearchParam(params, key) ?? field.defaultValue;
    case "enumList": {
      const raw = params.get(key);
      if (raw == null || raw === "") return field.defaultValue;
      const delimiter = field.delimiter ?? ",";
      const items: unknown[] = [];
      for (const piece of raw.split(delimiter)) {
        const trimmed = piece.trim();
        if (trimmed === "") continue;
        const item = field.normalizeItem ? field.normalizeItem(trimmed) : trimmed;
        if (item === null) continue;
        if ((!field.allowedValues || field.allowedValues.includes(item)) && !items.includes(item)) {
          items.push(item);
        }
      }
      const limited = field.maxItems == null ? items : items.slice(0, field.maxItems);
      return limited;
    }
  }
}

function isEqualValue<V>(a: V, b: V, field: UrlStateFieldVariants<V>): boolean {
  if (field.kind === "enumList") {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  return Object.is(a, b);
}

function encodeField<V>(value: V, field: UrlStateFieldVariants<V>): string | null {
  switch (field.kind) {
    case "enum":
      return field.encode ? field.encode(value) : String(value);
    case "boundedNumber":
      return String(value);
    case "string":
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "enumList": {
      if (!Array.isArray(value) || value.length === 0) return null;
      const delimiter = field.delimiter ?? ",";
      return value.map((item) => String(item)).join(delimiter);
    }
  }
}

export function decodeState<T>(
  query: SearchInput,
  schema: UrlStateSchema<T>,
): T {
  const params = toSearchParams(query);
  const result: Record<string, unknown> = {};
  const fields = schema as Record<string, DecodedField>;
  for (const key in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    result[key] = decodeField(params, key, fields[key]);
  }
  return result as T;
}

export function encodeState<T>(
  state: T,
  schema: UrlStateSchema<T>,
): string {
  const params = new URLSearchParams();
  const keys = Object.keys(schema).sort() as (keyof T & string)[];
  for (const key of keys) {
    const field = schema[key];
    const value = state[key];
    if (isEqualValue(value, field.defaultValue, field)) continue;
    const encoded = encodeField(value, field);
    if (encoded == null || encoded === "") continue;
    params.set(key, encoded);
  }
  return params.toString();
}
