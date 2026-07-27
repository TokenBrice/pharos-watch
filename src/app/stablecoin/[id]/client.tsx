"use client";

import type { ReactNode } from "react";
import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useNearViewport } from "@/hooks/use-near-viewport";
import {
  useStablecoinDetailViewModel,
  type StablecoinDetailSummary,
} from "@/hooks/use-stablecoin-detail-view-model";
import type { CollateralUsageEntry } from "@/lib/collateral-usage-model";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-mint-authority-view-model";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { DetailContent } from "./detail-content";

function DetailLoadingShell({
  coin,
  logoSrc,
  staticProfileContent = null,
}: {
  coin: StablecoinStaticMeta;
  logoSrc?: string;
  staticProfileContent?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <StablecoinDetailLoadingShell
        coin={coin}
        logoSrc={logoSrc}
        description="Loading research dossier…"
        statusLabel="Loading…"
      />
      <div className="mt-10 rounded-xl border border-border/60 p-4">
        <Skeleton className="mb-4 h-6 w-32" />
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex items-center gap-4">
            <Skeleton className="h-14 w-14 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
          <Skeleton className="h-[180px] rounded-xl" />
        </div>
      </div>
      {staticProfileContent ? <div className="mt-12">{staticProfileContent}</div> : null}
      <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-[200px] rounded-xl" />
        <Skeleton className="h-[200px] rounded-xl" />
      </div>
      <Skeleton className="mt-12 h-[420px] rounded-xl" />
    </div>
  );
}

interface StablecoinDetailClientProps {
  id: string;
  coin: StablecoinDetailCoinMeta;
  summary: StablecoinDetailSummary | null;
  staticCoin: StablecoinStaticMeta;
  logoSrc?: string;
  collateralUsageEntries?: readonly CollateralUsageEntry[];
  mechanismCollateralization?: MechanismCollateralizationView | null;
  staticProfileContent?: ReactNode;
  exploreNextContent?: ReactNode;
  faqContent?: ReactNode;
}

export default function StablecoinDetailClient({
  id,
  coin,
  summary,
  staticCoin,
  logoSrc,
  collateralUsageEntries = [],
  mechanismCollateralization = null,
  staticProfileContent = null,
  exploreNextContent = null,
  faqContent = null,
}: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [activeBannerId, setActiveBannerId] = useState("overview");
  const heroRef = useRef<HTMLDivElement>(null);
  const { ref: overviewGateRef, near: overviewNear } = useNearViewport<HTMLDivElement>("600px");
  const { ref: activityGateRef, near: activityNear } = useNearViewport<HTMLDivElement>("600px");
  const { ref: historyGateRef, near: historyNear } = useNearViewport<HTMLDivElement>("600px");
  const activityOrHistoryNear = activityNear || historyNear;
  const viewModel = useStablecoinDetailViewModel({
    id,
    coin,
    summary,
    logoSrc,
    supplementalQueryControls: {
      flows: overviewNear || activityOrHistoryNear,
      blacklist: activityOrHistoryNear,
      reserves: overviewNear,
    },
  });

  if (viewModel.status === "loading") {
    return <DetailLoadingShell coin={staticCoin} logoSrc={logoSrc} staticProfileContent={staticProfileContent} />;
  }
  if (viewModel.status === "list-error") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <QueryErrorNotice error={viewModel.listError} hasData={false} onRetry={viewModel.handleRetryAll} />
      </div>
    );
  }
  if (viewModel.status === "not-found") {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/"><ArrowLeft className="mr-2 h-4 w-4" />Back to Dashboard</Link>
        </Button>
        <p className="text-muted-foreground">This stablecoin is not part of the tracked Pharos universe.</p>
      </div>
    );
  }

  return (
    <DetailContent
      activeBannerId={activeBannerId}
      activityGateRef={activityGateRef}
      collateralUsageEntries={collateralUsageEntries}
      exploreNextContent={exploreNextContent}
      faqContent={faqContent}
      feedbackOpen={feedbackOpen}
      heroRef={heroRef}
      historyGateRef={historyGateRef}
      onActiveBannerChange={setActiveBannerId}
      mechanismCollateralization={mechanismCollateralization}
      onFeedbackOpenChange={setFeedbackOpen}
      overviewGateRef={overviewGateRef}
      staticHasCollateralUsage={staticCoin.hasCollateralUsage}
      viewModel={viewModel}
    />
  );
}
