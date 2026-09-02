export interface JsonHttpResponseOptions {
  status?: number;
  headers?: HeadersInit;
}

export interface CloneResponseOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: HeadersInit;
  mutateHeaders?: (headers: Headers) => void;
}

/** Runtime-neutral response cloning with explicit body and header policy. */
export function cloneResponse(response: Response, options: CloneResponseOptions = {}): Response {
  const headers = new Headers(options.headers ?? response.headers);
  options.mutateHeaders?.(headers);
  const body = options.method === "HEAD"
    ? null
    : options.body !== undefined
      ? options.body
      : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
