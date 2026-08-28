export interface JsonHttpResponseOptions {
  status?: number;
  headers?: HeadersInit;
}

/** Runtime-neutral JSON response factory; cache/logging policy stays with callers. */
export function createJsonResponse(body: unknown, options: JsonHttpResponseOptions = {}): Response {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    status: options.status,
    headers,
  });
}

export function createJsonErrorResponse(
  status: number,
  message: string,
  options: Omit<JsonHttpResponseOptions, "status"> = {},
): Response {
  return createJsonResponse({ error: message }, { ...options, status });
}
