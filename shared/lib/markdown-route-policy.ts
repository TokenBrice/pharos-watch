const MARKDOWN_ROUTE_PREFIXES = [
  "/methodology/",
  "/stablecoin/",
  "/changelog/",
  "/digest/",
  "/docs/",
] as const;

const GENERATED_MARKDOWN_ASSET_SUFFIX = "/index.md";

function hasMarkdownRoutePrefix(pathname: string): boolean {
  return MARKDOWN_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isNegotiableMarkdownRoute(pathname: string): boolean {
  return pathname.endsWith("/") && hasMarkdownRoutePrefix(pathname);
}

export function getGeneratedMarkdownAssetPath(routePath: string): string | null {
  return isNegotiableMarkdownRoute(routePath) ? `${routePath}index.md` : null;
}

export function getCanonicalPathForMarkdownAsset(pathname: string): string | null {
  if (!pathname.endsWith(GENERATED_MARKDOWN_ASSET_SUFFIX) || !hasMarkdownRoutePrefix(pathname)) {
    return null;
  }
  return `${pathname.slice(0, -GENERATED_MARKDOWN_ASSET_SUFFIX.length)}/`;
}
