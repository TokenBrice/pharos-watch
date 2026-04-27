import Link from "next/link";
import {
  MethodologyFacts,
  MethodologySectionShell,
} from "../../methodology-shared";

export const CONTENT_MARKDOWN = `## Stablecoin Lifecycle Phases\n\nEvery tracked stablecoin sits in one of three lifecycle phases: active, pre-launch, or frozen. The phase controls which surfaces ingest, score, and display the coin. It is a data-collection lifecycle policy, not a scoring methodology — per-domain version constants (Safety Scores, Liquidity, PegScore + DEWS, PSI, Yield, Mint/Burn Flow, Pricing Pipeline, Blacklist Tracker, Chain Health) are unaffected when a coin transitions between phases.\n\nActive coins receive full data collection and contribute to every aggregate. Pre-launch coins are listed for context on the upcoming page but have no live data yet. Frozen coins are archived: their historical data and detail page are preserved, but no new data is collected, and they are excluded from live aggregates and new score computations.\n`;

export function LifecyclePhasesMethodologySection() {
  return (
    <MethodologySectionShell
      id="lifecycle-phases-methodology"
      title="Stablecoin Lifecycle Phases"
      accentClassName="border-l-zinc-500"
      versionNote="Lifecycle phase is a data-collection policy. No per-domain methodology version is bumped when a coin transitions between phases."
    >
      <p>
        Every tracked stablecoin is in one of three lifecycle phases. The phase determines which
        surfaces ingest, score, and read back the coin&apos;s data. Scoring methodologies always
        operate over the active subset; pre-launch and frozen coins are excluded from new
        computations and live aggregates.
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
          <Link href="/upcoming/" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">
            /upcoming
          </Link>
          {" "}with milestone metadata; not in the homepage table, search, or compare.
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
          <Link href="/cemetery/" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">
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
            value: "Every tracked coin (active + pre-launch + frozen). Used for canonical-ID lookups and registry validation.",
          },
          {
            label: "ACTIVE",
            value: "Active subset only. Used by every write-side cron and live aggregate.",
          },
          {
            label: "READABLE",
            value: "Active + frozen. Used by the sitemap, search, compare picker, detail-page API endpoints, and OG renderer so frozen archives stay reachable.",
          },
          {
            label: "FROZEN",
            value: "Frozen subset only. Drives the cemetery merge and the dataset export.",
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <Link href="/cemetery/" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">
          Cemetery
        </Link>
        {" · "}
        <Link href="/upcoming/" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">
          Upcoming launches
        </Link>
        {" · "}
        <span className="text-foreground/70">Operator runbook: <code className="text-xs">docs/freezing-stablecoins.md</code></span>
      </p>
    </MethodologySectionShell>
  );
}
