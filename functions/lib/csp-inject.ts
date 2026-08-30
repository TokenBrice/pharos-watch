/**
 * Shared HTML CSP injection for Cloudflare Pages Function handlers.
 * Used by both the site middleware and the ops asset host gate so the
 * nonce-rewrite + cache/encoding header sequence stays in one place.
 */
import {
  addNonceToInlineScripts,
  buildContentSecurityPolicy,
  createCspNonce,
} from "@shared/lib/site-csp";
import { NOINDEX_HEADER_VALUE } from "./noindex";
import { isHtmlResponse } from "./proxy-utils";
import { cloneResponseWithPolicy } from "./response-policy";

export interface InjectHtmlCspOptions {
  method: string;
  cspOptions?: { telegramMiniApp?: boolean };
  /** Apply handler-specific header mutations (e.g. Vary) before the body is rewritten. */
  mutateHeaders?: (headers: Headers) => void;
}

/**
 * Rewrite an HTML response to carry a fresh CSP nonce and no-store cache headers.
 * Non-HTML responses pass through untouched. The decoded body is returned, so any
 * inherited upstream Content-Encoding is dropped to keep the transport encoding sane.
 */
export async function injectHtmlCsp(response: Response, options: InjectHtmlCspOptions): Promise<Response> {
  if (!isHtmlResponse(response)) return response;

  const nonce = createCspNonce();
  const mutateHeaders = (headers: Headers): void => {
    headers.set("Content-Security-Policy", buildContentSecurityPolicy(nonce, options.cspOptions));
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.set("CDN-Cache-Control", "no-store");
    headers.delete("Content-Length");
    if (options.cspOptions?.telegramMiniApp) {
      headers.delete("X-Frame-Options");
      headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE);
    }
    options.mutateHeaders?.(headers);
  };

  if (options.method === "HEAD") {
    return cloneResponseWithPolicy(response, {
      method: options.method,
      mutateHeaders,
    });
  }

  const html = addNonceToInlineScripts(await response.text(), nonce);

  // `response.text()` yields the decoded body, so any inherited upstream
  // Content-Encoding is now stale. Return decoded HTML and let Cloudflare's edge
  // compression handle the final transport encoding for Pages Functions.
  return cloneResponseWithPolicy(response, {
    body: html,
    mutateHeaders: (headers) => {
      mutateHeaders(headers);
      headers.delete("Content-Encoding");
    },
  });
}
