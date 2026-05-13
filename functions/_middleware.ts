import {
  addNonceToInlineScripts,
  buildContentSecurityPolicy,
  createCspNonce,
} from "../shared/lib/site-csp";

interface MiddlewareEnv {
  ASSETS?: { fetch: typeof fetch };
}

interface MiddlewareContext {
  request: Request;
  env: MiddlewareEnv;
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
}

const MARKDOWN_ROUTE_PREFIXES = [
  "/methodology/",
  "/stablecoin/",
  "/changelog/",
  "/digest/",
  "/docs/",
] as const;

const PASSTHROUGH_PREFIXES = ["/_site-data/", "/_next/"] as const;
const CANONICAL_SITE_ORIGIN = "https://pharos.watch";
const GENERATED_MARKDOWN_ASSET_SUFFIX = "/index.md";

export { buildContentSecurityPolicy };

function parseQ(params: string[]): number {
  const qParam = params.find((param) => /^q\s*=/i.test(param));
  if (!qParam) return 1;
  const q = Number.parseFloat(qParam.split("=")[1]?.trim() ?? "");
  if (!Number.isFinite(q)) return 0;
  return Math.min(1, Math.max(0, q));
}

export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;

  const entries = accept
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const [type = "", ...params] = entry.split(";").map((part) => part.trim());
      return { type: type.toLowerCase(), q: parseQ(params) };
    });

  const markdownQ = Math.max(
    ...entries
      .filter((entry) => entry.type === "text/markdown" || entry.type === "text/x-markdown")
      .map((entry) => entry.q),
    -Infinity,
  );
  if (!Number.isFinite(markdownQ)) return false;

  const htmlQ = Math.max(
    ...entries
      .filter((entry) => entry.type === "text/html" || entry.type === "text/*" || entry.type === "*/*")
      .map((entry) => entry.q),
    -Infinity,
  );
  const htmlEffective = Number.isFinite(htmlQ) ? htmlQ : -Infinity;

  return markdownQ > 0 && markdownQ >= htmlEffective;
}

function matchesMarkdownRoute(pathname: string): boolean {
  if (!pathname.endsWith("/")) return false;
  return MARKDOWN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function directMarkdownAssetCanonicalPath(pathname: string): string | null {
  if (!pathname.endsWith(GENERATED_MARKDOWN_ASSET_SUFFIX)) return null;
  if (!MARKDOWN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  return `${pathname.slice(0, -GENERATED_MARKDOWN_ASSET_SUFFIX.length)}/`;
}

function matchesPassthrough(pathname: string): boolean {
  return PASSTHROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isNegotiableMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function hasVaryToken(value: string | null, token: string): boolean {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes(token.toLowerCase());
}

function addVaryAccept(headers: Headers): void {
  const existing = headers.get("Vary");
  if (!hasVaryToken(existing, "Accept")) {
    headers.set("Vary", existing ? `${existing}, Accept` : "Accept");
  }
}

function addNegotiationCacheHeaders(headers: Headers): void {
  addVaryAccept(headers);
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("CDN-Cache-Control", "no-store");
}

function addDirectMarkdownAssetSeoHeaders(headers: Headers, canonicalPath: string): void {
  const canonicalUrl = new URL(canonicalPath, CANONICAL_SITE_ORIGIN);
  const canonicalLink = `<${canonicalUrl.toString()}>; rel="canonical"`;
  const existingLink = headers.get("Link");

  headers.set("X-Robots-Tag", "noindex, follow");
  headers.set("Link", existingLink ? `${existingLink}, ${canonicalLink}` : canonicalLink);
}

function addCspHeaders(headers: Headers, nonce: string): void {
  headers.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.delete("Content-Length");
}

function isHtmlResponse(response: Response): boolean {
  return response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
}

function cloneForMethod(response: Response, method: string, headers: Headers): Response {
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withNegotiationHeaders(response: Response, method: string): Response {
  const headers = new Headers(response.headers);
  addNegotiationCacheHeaders(headers);
  return cloneForMethod(response, method, headers);
}

async function withHtmlCsp(response: Response, method: string): Promise<Response> {
  if (!isHtmlResponse(response)) return response;

  const nonce = createCspNonce();
  const headers = new Headers(response.headers);
  addCspHeaders(headers, nonce);

  if (method === "HEAD") {
    return cloneForMethod(response, method, headers);
  }

  return new Response(addNonceToInlineScripts(await response.text(), nonce), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const onRequest = async (ctx: MiddlewareContext): Promise<Response> => {
  const url = new URL(ctx.request.url);

  if (matchesPassthrough(url.pathname) || !isNegotiableMethod(ctx.request.method)) {
    return ctx.next();
  }

  const directMarkdownCanonicalPath = directMarkdownAssetCanonicalPath(url.pathname);
  if (directMarkdownCanonicalPath) {
    const directMarkdownResponse = await ctx.next();
    if (!directMarkdownResponse.ok) return directMarkdownResponse;

    const headers = new Headers(directMarkdownResponse.headers);
    addDirectMarkdownAssetSeoHeaders(headers, directMarkdownCanonicalPath);
    return cloneForMethod(directMarkdownResponse, ctx.request.method, headers);
  }

  const shouldTryMarkdown =
    matchesMarkdownRoute(url.pathname) && prefersMarkdown(ctx.request.headers.get("Accept"));

  if (shouldTryMarkdown && ctx.env.ASSETS) {
    const mdUrl = new URL(url);
    mdUrl.pathname = `${url.pathname}index.md`;
    mdUrl.search = "";
    const mdResponse = await ctx.env.ASSETS.fetch(new Request(mdUrl.toString(), { method: "GET" }));

    if (mdResponse.ok) {
      const headers = new Headers(mdResponse.headers);
      headers.set("Content-Type", "text/markdown; charset=utf-8");
      addNegotiationCacheHeaders(headers);
      return cloneForMethod(mdResponse, ctx.request.method, headers);
    }
  }

  const fallback = await ctx.next();
  const negotiated = matchesMarkdownRoute(url.pathname)
    ? withNegotiationHeaders(fallback, ctx.request.method)
    : fallback;
  return withHtmlCsp(negotiated, ctx.request.method);
};
