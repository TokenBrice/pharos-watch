"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StablecoinDetailLoadingShell } from "@/components/stablecoin-detail/loading-shell";
import { StablecoinDetailIdentityProvider } from "@/components/stablecoin-detail/module-title";
import { Skeleton } from "@/components/ui/skeleton";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { asMetaQueryOptions, createRegisteredApiPollingQueryOptions } from "@/hooks/api-hooks";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import {
  useStablecoinDetailViewModel,
  type StablecoinDetailSummary,
} from "@/hooks/use-stablecoin-detail-view-model";
import type { BackingMetricsInput } from "@/components/stablecoin-detail/backing-metrics-card";
import type { MechanismBackingView } from "@/lib/mechanism-backing";
import type { MechanismCollateralizationView } from "@/lib/mechanism-collateralization";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type { TransferReviewView } from "@/lib/transfer-review";
import type { FailureScenarioSelection } from "@/components/stablecoin-detail/failure-scenario/scenario-model";
import type { StablecoinDetailCoinMeta } from "@/lib/stablecoin-detail-client-coin";
import type { StablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import {
  seedStablecoinDetailQueryCache,
  type StablecoinDetailSnapshot,
} from "@/lib/api";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { hasDataBootstrap } from "@/lib/data-bootstrap";
import { DetailEvidenceProvider } from "@/lib/detail-evidence";
import { DetailContent } from "./detail-content";

function DetailLoadingShell({
  coin,
  logoSrc,
}: {
  coin: StablecoinStaticMeta;
  logoSrc?: string;
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
  mechanismBacking?: MechanismBackingView | null;
  mechanismCollateralization?: MechanismCollateralizationView | null;
  mechanismReview?: MechanismReviewView | null;
  /** The variant parent's `deriveLiquidationEngine` result, for a wrapper's Mechanism flow. */
  parentLiquidationEngine?: boolean | null;
  /** A pure or savings pass-through wrapper's parent, for the Backing KPI's "via <parent>" look-through. */
  backingParent?: NonNullable<BackingMetricsInput["parent"]> | null;
  transferReview?: TransferReviewView | null;
  /** The coin's publishable failure scenario (a marked draft in development), or null. */
  failureScenario?: FailureScenarioSelection | null;
  exploreNextContent?: ReactNode;
  faqContent?: ReactNode;
  snapshot?: StablecoinDetailSnapshot | null;
  /** Frozen coins only: archived list row used when the live detail row is unavailable. */
  archivedLiveSummary?: StablecoinLiveSummary | null;
}

export function StablecoinDetailSnapshotHydrator({
  children,
  snapshot,
}: {
  children: ReactNode;
  snapshot: StablecoinDetailSnapshot | null;
}) {
  const queryClient = useQueryClient();

  // Like HydrationBoundary, populate the cache while rendering the boundary so
  // child query observers see the snapshot before they can start a request.
  // The keyed route client remounts when its coin ID changes.
  useState(() => {
    if (snapshot) seedStablecoinDetailQueryCache(queryClient, snapshot);
    return snapshot;
  });

  return children;
}
/** Adopt the parser-started read only after the saved dossier has hydrated. */
export function StablecoinDetailLiveSummaryStart({ id, children }: { id: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    // The raw request already starts in the route's parser bootstrap. Publishing
    // its result during render can replace seed provenance before a suspended
    // child hydrates, making its first freshness verdict differ from the server.
    // Mount-time adoption keeps that first render on the same saved generation.
    // SPA entries without bootstrap retain the canonical fresh-cache policy.
    const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(id);
    const options = asMetaQueryOptions(createRegisteredApiPollingQueryOptions(descriptor));
    void queryClient.prefetchQuery(hasDataBootstrap(descriptor.queryKey) ? { ...options, staleTime: 0 } : options);
  }, [id, queryClient]);
  return children;
}


function StablecoinDetailClientContent({
  id,
  coin,
  summary,
  staticCoin,
  logoSrc,
  mechanismBacking = null,
  mechanismCollateralization = null,
  mechanismReview = null,
  parentLiquidationEngine = null,
  backingParent = null,
  transferReview = null,
  failureScenario = null,
  exploreNextContent = null,
  faqContent = null,
  archivedLiveSummary = null,
}: StablecoinDetailClientProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [activeBannerId, setActiveBannerId] = useState("overview");
  const heroRef = useRef<HTMLDivElement>(null);
  const { ref: overviewGateRef, near: overviewNear } = useNearViewport<HTMLDivElement>("600px");
  const { ref: activityGateRef, near: activityNear } = useNearViewport<HTMLDivElement>("600px");
  const { ref: historyGateRef, near: historyNear } = useNearViewport<HTMLDivElement>("600px");
  const overviewActive = overviewNear;
  const activityActive = activityNear;
  const historyActive = historyNear;
  const activityOrHistoryActive = activityActive || historyActive;
  const viewModel = useStablecoinDetailViewModel({
    id,
    coin,
    summary,
    logoSrc,
    archivedLiveSummary,
    supplementalQueryControls: {
      // Hero liquidity/yield observers now read only this coin's scoped projections.
      liquidity: true,
      reportCards: true,
      // The redemption route lives in the Risk zone's exit evidence.
      redemption: overviewActive,
      yield: true,
      stress: true,
      flows: overviewActive || activityOrHistoryActive,
      blacklist: activityOrHistoryActive,
      reserves: overviewActive,
    },
  });

  if (viewModel.status === "loading") {
    return <DetailLoadingShell coin={staticCoin} logoSrc={logoSrc} />;
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

  return (
    <StablecoinDetailIdentityProvider symbol={viewModel.coin.symbol} logoSrc={viewModel.logoSrc}>
      <DetailContent
        activeBannerId={activeBannerId}
        activityGateRef={activityGateRef}
        exploreNextContent={exploreNextContent}
        faqContent={faqContent}
        feedbackOpen={feedbackOpen}
        heroRef={heroRef}
        historyGateRef={historyGateRef}
        onActiveBannerChange={setActiveBannerId}
        mechanismBacking={mechanismBacking}
        mechanismCollateralization={mechanismCollateralization}
        mechanismReview={mechanismReview}
        parentLiquidationEngine={parentLiquidationEngine}
        backingParent={backingParent}
        transferReview={transferReview}
        failureScenario={failureScenario}
        onFeedbackOpenChange={setFeedbackOpen}
        overviewGateRef={overviewGateRef}
        viewModel={viewModel}
      />
    </StablecoinDetailIdentityProvider>
  );
}

export default function StablecoinDetailClient(props: StablecoinDetailClientProps) {
  return (
    <StablecoinDetailSnapshotHydrator snapshot={props.snapshot ?? null}>
      <StablecoinDetailLiveSummaryStart key={props.id} id={props.id}>
        <DetailEvidenceProvider coinId={props.id}>
          <StablecoinDetailClientContent {...props} />
        </DetailEvidenceProvider>
      </StablecoinDetailLiveSummaryStart>
    </StablecoinDetailSnapshotHydrator>
  );
}
