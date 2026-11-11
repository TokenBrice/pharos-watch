import { isOpsPath } from "@/lib/admin-workspaces";

type RoutePresentationDescriptor = {
  home?: true;
  dataAnchor?: true;
  mobileBottomNav?: true;
  feedback?: false;
  descendants?: true;
  chromeless?: true;
  routeFooter?: true;
  editorial?: true;
};

const ROUTE_PRESENTATION: Readonly<Record<string, RoutePresentationDescriptor>> = {
  "/": { home: true, dataAnchor: true, mobileBottomNav: true },
  "/liquidity": { dataAnchor: true },
  "/screener": { dataAnchor: true },
  "/flows": { dataAnchor: true },
  "/timeline": { dataAnchor: true },
  "/safety-scores": { dataAnchor: true, mobileBottomNav: true },
  "/freezewatch": { dataAnchor: true },
  "/depeg": { dataAnchor: true, mobileBottomNav: true },
  "/compliance": { dataAnchor: true },
  "/yield": { dataAnchor: true, mobileBottomNav: true },
  "/api": { feedback: false },
  "/api/reference": { feedback: false },
  "/pharoswatchbot/app": { descendants: true, chromeless: true },
  "/digest": { descendants: true, routeFooter: true },
  "/privacy": { descendants: true, editorial: true },
  "/about": { descendants: true, editorial: true },
  "/docs": { descendants: true, editorial: true },
  "/blog": { descendants: true, editorial: true },
  "/methodology": { descendants: true, editorial: true },
  "/learn": { descendants: true, editorial: true },
  "/changelog": { descendants: true, editorial: true },
  "/legal": { descendants: true, editorial: true },
};

const ROUTE_PRESENTATION_FAMILIES = Object.entries(ROUTE_PRESENTATION)
  .filter(([, descriptor]) => descriptor.descendants);

export function getRouteCapabilities(pathname: string | null | undefined) {
  const presentation = pathname ? ROUTE_PRESENTATION[pathname.replace(/\/$/, "") || "/"] : undefined;
  const family = ROUTE_PRESENTATION_FAMILIES.find(([root]) => pathname === root || pathname?.startsWith(`${root}/`))?.[1];
  const chromeless = family?.chromeless === true;
  const ops = isOpsPath(pathname);
  const home = !!pathname && ROUTE_PRESENTATION[pathname]?.home === true;
  return {
    chrome: ops ? "ops" as const : chromeless ? "chromeless" as const : "public" as const,
    chromeless,
    home,
    editorial: family?.editorial === true,
    dataAnchor: !chromeless && !ops && presentation?.dataAnchor === true,
    mobileBottomNav: presentation?.mobileBottomNav === true,
    regimeBar: !chromeless && !ops && !home,
    footer: chromeless || ops || family?.routeFooter ? "route" as const : home ? "home" as const : "global" as const,
    feedback: !(home || presentation?.feedback === false),
  };
}
