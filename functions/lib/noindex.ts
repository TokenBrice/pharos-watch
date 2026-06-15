export const NOINDEX_HEADER_VALUE = "noindex, nofollow";

export function withNoindex(response: Response): Response {
  const wrapped = new Response(response.body, response);
  wrapped.headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE);
  return wrapped;
}

export function noindexTextNotFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": NOINDEX_HEADER_VALUE,
    },
  });
}
