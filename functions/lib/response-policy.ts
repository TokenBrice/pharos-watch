export interface ResponsePolicyOptions {
  method?: string;
  body?: BodyInit | null;
  mutateHeaders?: (headers: Headers) => void;
}

export function cloneResponseWithPolicy(
  response: Response,
  options: ResponsePolicyOptions = {},
): Response {
  const headers = new Headers(response.headers);
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
