import { stripSensitive } from "./safe-error-message";

interface SensitiveMetadataOptions {
  maxStringChars: number;
  maxStackChars: number;
  maxKeys: number;
  maxArrayItems: number;
  maxDepth: number;
  emptyErrorNameFallback?: string;
}

export function sanitizeBoundedMetadata(
  value: unknown,
  options: SensitiveMetadataOptions,
  depth = 0,
): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const sanitized = stripSensitive(value);
    return sanitized.length <= options.maxStringChars
      ? sanitized
      : `${sanitized.slice(0, options.maxStringChars)}...`;
  }
  if (value instanceof Error) {
    return {
      name: value.name || options.emptyErrorNameFallback || "",
      message: stripSensitive(value.message).slice(0, options.maxStringChars),
      ...(value.stack ? { stack: stripSensitive(value.stack).slice(0, options.maxStackChars) } : {}),
    };
  }
  if (depth >= options.maxDepth) return "[truncated-depth]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, options.maxArrayItems)
      .map((item) => sanitizeBoundedMetadata(item, options, depth + 1));
    if (value.length > options.maxArrayItems) items.push(`[${value.length - options.maxArrayItems} more]`);
    return items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, options.maxKeys)) {
      bounded[key] = sanitizeBoundedMetadata(entryValue, options, depth + 1);
    }
    if (entries.length > options.maxKeys) bounded.truncatedKeys = entries.length - options.maxKeys;
    return bounded;
  }
  return stripSensitive(String(value)).slice(0, options.maxStringChars);
}
