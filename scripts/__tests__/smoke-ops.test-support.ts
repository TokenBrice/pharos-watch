export const ACCESS_HEADERS = Object.freeze({
  "CF-Access-Client-Id": "id",
  "CF-Access-Client-Secret": "secret",
});

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function textResponse(body: string, status: number) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
