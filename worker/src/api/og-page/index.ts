import type { OgPageSlug } from "@shared/lib/og-route-cards";
import { loadChainsOgPage } from "./chains";
import { loadDependencyMapOgPage } from "./dependency-map";
import { loadFlowsOgPage } from "./flows";
import { loadFreezewatchOgPage } from "./freezewatch";
import { loadHomeOgPage } from "./home";
import { loadLiquidityOgPage } from "./liquidity";
import { loadTimelineOgPage } from "./timeline";
import type { OgPageLoader } from "./types";
import { loadYieldOgPage } from "./yield";

/** One loader per live route card; the `Record` keeps the registry complete over `OG_LIVE_PAGE_SLUGS`. */
export const OG_PAGE_LOADERS: Readonly<Record<OgPageSlug, OgPageLoader>> = {
  home: loadHomeOgPage,
  chains: loadChainsOgPage,
  "dependency-map": loadDependencyMapOgPage,
  timeline: loadTimelineOgPage,
  flows: loadFlowsOgPage,
  freezewatch: loadFreezewatchOgPage,
  liquidity: loadLiquidityOgPage,
  yield: loadYieldOgPage,
};

export type { OgPageFigure, OgPageLoad } from "./types";
