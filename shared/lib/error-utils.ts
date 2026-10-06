import type { ErrorDescriptor } from "../types/error";

// Read data properties only: diagnostics must not execute thrown values' code.
function dataProperty(value: object, key: string): unknown {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < 4; depth++) {
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property) return "value" in property ? property.value : undefined;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    // Proxies may reject reflection; the descriptor still supplies a safe fallback.
  }
  return undefined;
}

/**
 * Bounded, runtime-neutral diagnostics. Workers supply their existing sanitizer
 * so every string is redacted before bounds, rather than truncating secrets.
 */
export function describeError(
  error: unknown,
  sanitize: (value: string) => string = (value) => value,
): ErrorDescriptor {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): ErrorDescriptor => {
    nodes++;
    let truncated = false;
    const bounded = (text: string, limit: number): string => {
      const cleaned = sanitize(text);
      if (cleaned.length > limit) truncated = true;
      return cleaned.slice(0, limit);
    };
    const object = value !== null && (typeof value === "object" || typeof value === "function")
      ? value : null;
    const rawName = object ? dataProperty(object, "name") : undefined;
    const rawMessage = object ? dataProperty(object, "message") : undefined;
    let isError = false;
    try { isError = value instanceof Error; } catch { /* Hostile proxy. */ }
    const name = bounded(typeof rawName === "string" && rawName.trim() ? rawName : isError ? "Error" : "NonError", 100) || "NonError";
    if (object && seen.has(object)) return { name, message: "Circular error", truncated: true };
    if (object) seen.add(object);
    let message = bounded(typeof rawMessage === "string" ? rawMessage : object ? "" :
      typeof value === "symbol" ? (value.description ? `Symbol(${value.description})` : "Symbol()") :
      typeof value === "function" ? "Function thrown" : String(value), 500);
    if (!message.trim()) message = isError ? `${name} (no message)` : "Non-error value thrown";
    const descriptor: ErrorDescriptor = { name, message };
    if (object) {
      const code = dataProperty(object, "code");
      if (typeof code === "string" || typeof code === "number") descriptor.code = bounded(String(code), 100);
      const stack = depth === 0 ? dataProperty(object, "stack") : undefined;
      if (typeof stack === "string") descriptor.stack = bounded(stack, 800);
      const cause = dataProperty(object, "cause");
      const children = dataProperty(object, "errors");
      let aggregate = false;
      try { aggregate = Array.isArray(children); } catch { /* Hostile proxy. */ }
      if (depth < 3) {
        if (cause !== undefined && nodes < 12) descriptor.cause = visit(cause, depth + 1);
        else if (cause !== undefined) truncated = true;
        if (aggregate) {
          descriptor.errors = [];
          const length = dataProperty(children as object, "length");
          const count = typeof length === "number" ? Math.min(length, 5) : 0;
          for (let index = 0; index < count && nodes < 12; index++) {
            descriptor.errors.push(visit(dataProperty(children as object, String(index)), depth + 1));
          }
          if (typeof length === "number" && descriptor.errors.length < length) truncated = true;
        }
      } else if (cause !== undefined || aggregate) truncated = true;
      if (descriptor.cause) message += `; cause: ${descriptor.cause.message}`;
      if (descriptor.errors?.length) message += `; errors: ${descriptor.errors.map((child) => child.message).join("; ")}`;
      descriptor.message = bounded(message, 500);
    }
    if (truncated) descriptor.truncated = true;
    return descriptor;
  };
  return visit(error, 0);
}

export function toErrorMessage(error: unknown): string {
  return describeError(error).message;
}
