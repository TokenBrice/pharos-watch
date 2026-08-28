/** Cross-runtime HTTP response observations for contract tests. */
import { isDeepStrictEqual } from "node:util";

export type CanonicalJsonValue =
  boolean | null | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export type ResponseBodyKind = "empty" | "json" | "text";

export type HttpResponseObservation = {
  status: number;
  headers: Record<string, string>;
  bodyKind: ResponseBodyKind;
  canonicalBody: CanonicalJsonValue | string | null;
};

function canonicalizeJson(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }

  throw new Error(`Response JSON includes an unsupported ${typeof value} value`);
}

function isJsonContentType(contentType: string | null): boolean {
  return (
    contentType?.split(";", 1)[0]?.trim().toLowerCase().endsWith("+json") === true ||
    contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

/**
 * Consumes a response body once and retains only the explicitly requested
 * headers, so contract observations stay deterministic and non-volatile.
 */
export async function observeHttpResponse(
  response: Response,
  allowedHeaders: readonly string[] = [],
): Promise<HttpResponseObservation> {
  const headers = Object.fromEntries(
    [...new Set(allowedHeaders.map((header) => header.toLowerCase()))].sort().flatMap((header) => {
      const value = response.headers.get(header);
      return value === null ? [] : [[header, value]];
    }),
  );
  const rawBody = await response.text();

  if (rawBody.length === 0) {
    return { status: response.status, headers, bodyKind: "empty", canonicalBody: null };
  }

  if (isJsonContentType(response.headers.get("Content-Type"))) {
    return {
      status: response.status,
      headers,
      bodyKind: "json",
      canonicalBody: canonicalizeJson(JSON.parse(rawBody)),
    };
  }

  return { status: response.status, headers, bodyKind: "text", canonicalBody: rawBody };
}

export function matchesHttpResponseObservation(
  actual: HttpResponseObservation,
  expected: HttpResponseObservation,
): boolean {
  return isDeepStrictEqual(actual, expected);
}
