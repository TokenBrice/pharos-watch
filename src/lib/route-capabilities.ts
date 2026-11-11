import { isOpsPath } from "@/lib/admin-workspaces";

const DATA_TABLE_PATHS = new Set([
  "/", "/liquidity", "/screener", "/flows", "/timeline", "/safety-scores",
  "/freezewatch", "/depeg", "/compliance", "/yield",
]);

const EDITORIAL_ROUTE_ROOTS = [
  "/privacy", "/about", "/docs", "/blog", "/methodology", "/learn", "/changelog", "/legal",
];

export function getRouteCapabilities(pathname: string | null | undefined) {
  const chromeless = pathname === "/pharoswatchbot/app" || pathname?.startsWith("/pharoswatchbot/app/") === true;
  const ops = isOpsPath(pathname);
  const home = pathname === "/";
  const digest = pathname === "/digest" || pathname?.startsWith("/digest/") === true;
  return {
    chrome: ops ? "ops" as const : chromeless ? "chromeless" as const : "public" as const,
    chromeless,
    home,
    editorial: !!pathname && EDITORIAL_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`)),
    dataAnchor: !chromeless && !ops && !!pathname && DATA_TABLE_PATHS.has(pathname.replace(/\/$/, "") || "/"),
    regimeBar: !chromeless && !ops && !home,
    footer: chromeless || ops || digest ? "route" as const : home ? "home" as const : "global" as const,
    feedback: !(home || pathname === "/api" || pathname === "/api/" || pathname === "/api/reference" || pathname === "/api/reference/"),
  };
}
