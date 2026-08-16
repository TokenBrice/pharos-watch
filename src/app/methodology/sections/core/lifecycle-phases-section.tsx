import Link from "next/link";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyFacts,
  MethodologySectionShell,
} from "../../methodology-shared";
import { LIFECYCLE_PHASES_SECTION_CONTENT } from "@/lib/methodology-content";

export function LifecyclePhasesMethodologySection() {
  return (
    <MethodologySectionShell
      id={LIFECYCLE_PHASES_SECTION_CONTENT.id}
      title={LIFECYCLE_PHASES_SECTION_CONTENT.title}
      versionNote="Lifecycle phase is a data-collection policy. No per-domain methodology version is bumped when a coin transitions between phases."
    >
      <p>
        Every tracked stablecoin is in one of five lifecycle phases. The phase determines which
        surfaces ingest, score, and read back the coin&apos;s data. Scoring methodologies always
        operate over the active subset; every non-active phase is excluded from new computations
        and live aggregates.
      </p>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Active</h3>
        <p>
          Default state. Full worker ingestion (supply, price, blacklist, mint/burn, DEX liquidity,
          yield), full inclusion in PSI, DEWS, Safety Scores, Liquidity Score, Bank Run Gauge, and
          all live aggregates. Listed in the homepage table, search, compare picker, and sitemap.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Pre-launch</h3>
        <p>
          Tracked for visibility before launch. No live data yet, so the coin is excluded from
          score computations and live aggregates. Surfaced on{" "}
          <Link href="/upcoming/" className={METHODOLOGY_LINK_CLASS}>
            /upcoming
          </Link>
          {" "}with milestone metadata and on its own pre-launch detail page; not in the homepage
          table, active taxonomy pages, portfolio picker, or live comparison picker.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Quarantined</h3>
        <p>
          Temporarily withheld after a reviewed inability to establish positive circulating supply
          or market cap. The static profile, reason, and review date remain public, but providers are
          not refreshed and the record is excluded from live surfaces. Missing price coverage or a
          genuine depeg alone does not trigger quarantine; those remain active monitoring failures.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Delisted</h3>
        <p>
          Reviewed as outside the listing scope. The canonical static profile and sourced decision
          remain readable. Delisted records never enter live aggregates, alerts, or score
          recomputation.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Frozen</h3>
        <p>
          The coin is effectively defunct (issuer abandonment, supply trending to zero,
          irrecoverable depeg, regulatory shutdown) but its historical data and detail page are
          preserved as an archive. No new data is collected, and the coin is excluded from PSI,
          DEWS, Safety Score recomputations, Bank Run Gauge, and other live aggregates. Frozen
          entries appear in the{" "}
          <Link href="/cemetery/" className={METHODOLOGY_LINK_CLASS}>
            cemetery
          </Link>
          {" "}with an &quot;archived data available&quot; link to the preserved detail page. The
          report card shows an all-F stub matching the existing dead-stablecoin pattern.
        </p>
      </div>
      <MethodologyFacts
        facts={[
          {
            label: "TRACKED",
            value: "The complete catalog across all five phases. Used for canonical identity, validation, and static detail routes.",
          },
          {
            label: "ACTIVE",
            value: "Active subset only. Used by every write-side cron and live aggregate.",
          },
          {
            label: "READABLE",
            value: "Every post-launch record: active, quarantined, delisted, and frozen. Historical/read-only use only.",
          },
          {
            label: "FROZEN",
            value: "Frozen subset only. Drives the cemetery merge and the dataset export.",
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <Link href="/cemetery/" className={METHODOLOGY_LINK_CLASS}>
          Cemetery
        </Link>
        {" · "}
        <Link href="/upcoming/" className={METHODOLOGY_LINK_CLASS}>
          Upcoming launches
        </Link>
        {" · "}
        <Link href="/docs/listing-policy/" className={METHODOLOGY_LINK_CLASS}>
          Listing policy
        </Link>
        {" · "}
        <span className="text-foreground/70">Operator runbook: <code className="text-xs">docs/freezing-stablecoins.md</code></span>
      </p>
    </MethodologySectionShell>
  );
}
