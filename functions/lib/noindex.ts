import { cloneResponse } from "@shared/lib/http-response";

export const NOINDEX_HEADER_VALUE = "noindex, nofollow";

export function withNoindex(response: Response): Response {
  return cloneResponse(response, {
    mutateHeaders: (headers) => headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE),
  });
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
