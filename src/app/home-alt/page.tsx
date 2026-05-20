import { CHAIN_META } from "@shared/lib/chains";
import { HomeAltClient } from "@/components/home-alt-client";
import { SiteHeader } from "@/components/site-header";
import { buildPageMetadata, HOME_ALT_PAGE_METADATA } from "@/lib/page-metadata";
import {
  ACTIVE_PEG_CURRENCY_COUNT,
  ACTIVE_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

export const metadata = buildPageMetadata(HOME_ALT_PAGE_METADATA);

export default function HomeAltPage() {
  return (
    <div className="space-y-5 sm:space-y-6">
      <SiteHeader
        total={ACTIVE_STABLECOIN_COUNT}
        pegCount={ACTIVE_PEG_CURRENCY_COUNT}
        chainCount={Object.keys(CHAIN_META).length}
      />
      <HomeAltClient />
    </div>
  );
}
