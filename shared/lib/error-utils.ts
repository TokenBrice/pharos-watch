import type { ErrorDescriptor } from "../types/error";

// Platform errors expose fields through accessors; other thrown values only
// contribute own data properties so diagnostics do not execute arbitrary getters.
function errorProperty(value: object, key: string, isError = false): unknown {
  try {
    if (isError) return (value as Record<string, unknown>)[key];
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && "value" in property ? property.value : undefined;
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
  return buildErrorDescriptor(error, sanitize, true);
}

function buildErrorDescriptor(
  error: unknown,
  sanitize: (value: string) => string,
  includeStack: boolean,
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
    let isError = false;
    try {
      isError = value instanceof Error ||
        (typeof DOMException !== "undefined" && value instanceof DOMException);
    } catch { /* Hostile proxy. */ }
    const rawName = object ? errorProperty(object, "name", isError) : undefined;
    const rawMessage = object ? errorProperty(object, "message", isError) : undefined;
    const name = bounded(typeof rawName === "string" && rawName.trim() ? rawName : isError ? "Error" : "NonError", 100) || "NonError";
    if (object && seen.has(object)) return { name, message: "Circular error", truncated: true };
    if (object) seen.add(object);
    let message = bounded(typeof rawMessage === "string" ? rawMessage : object ? "" :
      typeof value === "symbol" ? (value.description ? `Symbol(${value.description})` : "Symbol()") :
      typeof value === "function" ? "Function thrown" : String(value), 500);
    if (!message.trim()) message = isError ? `${name} (no message)` : "Non-error value thrown";
    const descriptor: ErrorDescriptor = { name, message };
    if (object) {
      const code = errorProperty(object, "code", isError);
      if (typeof code === "string" || typeof code === "number") descriptor.code = bounded(String(code), 100);
      const stack = includeStack && depth === 0 ? errorProperty(object, "stack", isError) : undefined;
      if (typeof stack === "string") descriptor.stack = bounded(stack, 800);
      const cause = errorProperty(object, "cause", isError);
      const children = errorProperty(object, "errors", isError);
      let aggregate = false;
      try { aggregate = Array.isArray(children); } catch { /* Hostile proxy. */ }
      if (depth < 3) {
        if (cause !== undefined && nodes < 12) descriptor.cause = visit(cause, depth + 1);
        else if (cause !== undefined) truncated = true;
        if (aggregate) {
          descriptor.errors = [];
          const length = errorProperty(children as object, "length");
          const count = typeof length === "number" ? Math.min(length, 5) : 0;
          for (let index = 0; index < count && nodes < 12; index++) {
            descriptor.errors.push(visit(errorProperty(children as object, String(index)), depth + 1));
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
  // Reading a lazy stack materializes V8's retained script line index, even
  // when the caller only needs a message. Keep message-only diagnostics lazy.
  return buildErrorDescriptor(error, (value) => value, false).message;
}
