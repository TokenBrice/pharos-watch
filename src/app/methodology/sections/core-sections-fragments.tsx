import Link from "next/link";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { METHODOLOGY_LINK_CLASS } from "../methodology-shared";

export function CollateralQualityMethodologyCopy() {
  return (
    <p>
      Collateral quality is derived from reserve compositions when available. The default source is curated
      metadata. A live reserve snapshot replaces it only when the current report-card snapshot can prove the
      feed is fresh, authoritative, independent, and clean. In coverage tables this is the difference between
      a reserve view being configured and a score-grade live reserve actually being used. For report-card
      scoring, the live snapshot must carry scoring-eligible freshness evidence: either a verified timestamp
      path or an explicit on-chain latest-state{" "}
      <code className="text-xs bg-muted px-1 py-0.5 rounded">not-applicable</code> freshness mode.
      Direct one-bucket on-chain reserve proofs such as Liquity v1 can qualify when the adapter is
      classified as independent, but weak probe families do not qualify just because they are on-chain.
      Detail-only <code className="text-xs bg-muted px-1 py-0.5 rounded">static-validated</code> and{" "}
      <code className="text-xs bg-muted px-1 py-0.5 rounded">weak-live-probe</code> feeds remain visible
      on reserve surfaces, but they never override curated collateral scoring.
      A score-grade adapter can identify a source-owned reserve category with a stable source key. Reviewed metadata
      joins only to a unique matching key and fails closed on key mismatches or duplicates; historical unkeyed rows
      use a unique normalized-name compatibility match. The live percentage remains the scoring weight and is never
      used to decide whether the category is the same reserve slice.
      Each reserve slice is classified into one of five risk tiers and the score is their weighted average.
      Direct ETH and canonical WETH slices share the same Very Low tier, while ETH liquid staking tokens
      remain Low.{" "}
      <Link
        href="/learn/mechanisms/synthetic-delta-neutral/"
        className={METHODOLOGY_LINK_CLASS}
      >
        Delta-neutral
      </Link>
      {" "}wording is evaluated by structure: transparent spot or wrapped exposure can
      stay Medium, but externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent
      strategy books are High unless stronger granular evidence shows the slice is only a liquid stablecoin or
      cash-equivalent buffer. For coins without usable reserve compositions, a coarser enum-based fallback is used.
      Explicit overrides exist for coins where defaults are incorrect (e.g., protocols on Solana, coins
      with CEX custody).
    </p>
  );
}

export function ReserveRelatedSignalsMethodologyCopy() {
  return (
    <div className="space-y-2">
      <h3 className="text-foreground font-medium">Three Reserve-Related Signals</h3>
      <p>These labels are easy to conflate. They do different jobs, and only two can affect the Safety Score.</p>
      <TableFrame
        chrome="content"
        density="compact"
        tableId="methodology-reserve-related-signals"
        testId="methodology-reserve-related-signals-table"
        viewportProps={{ mobileScrollHint: false }}
      >
        <TableHeader>
          <TableRow className="text-left">
            <TableHead scope="col" className="py-2 pr-4 text-foreground">Signal</TableHead>
            <TableHead scope="col" className="py-2 pr-4 text-foreground">What it means</TableHead>
            <TableHead scope="col" className="py-2 text-foreground">Score use</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="py-2 pr-4 text-foreground">Reserve view</TableCell>
            <TableCell className="py-2 pr-4 whitespace-normal">A detail-page reserve display exists: live, curated-validated, proof, curated, or estimated.</TableCell>
            <TableCell className="py-2 whitespace-normal">Informational unless it also passes the score-grade live-reserve gates.</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="py-2 pr-4 text-foreground">Score-grade live reserve</TableCell>
            <TableCell className="py-2 pr-4 whitespace-normal">The current V9 fact set accepted a fresh, clean, independent live reserve snapshot as Backing evidence.</TableCell>
            <TableCell className="py-2 whitespace-normal">Can replace reviewed static reserve exposures inside V9 Backing and dependency compilation.</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="py-2 pr-4 text-foreground">Redemption telemetry</TableCell>
            <TableCell className="py-2 pr-4 whitespace-normal">A live reserve adapter emitted current redemption capacity, fee, freshness, or route-status metadata.</TableCell>
            <TableCell className="py-2 whitespace-normal">Can feed Redemption Backstop capacity or fee scoring; it does not automatically change collateral quality.</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>
    </div>
  );
}
