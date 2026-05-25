import {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-resolver-version";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
} from "../../methodology-shared";
import { DEPEG_RESOLVER_SECTION_CONTENT } from "../methodology-content";

export function DepegResolverMethodologySection() {
  return (
    <MethodologySectionShell
      id={DEPEG_RESOLVER_SECTION_CONTENT.id}
      title={DEPEG_RESOLVER_SECTION_CONTENT.title}
      versionLabel={DDR_METHODOLOGY_VERSION_LABEL}
      changelogPath={DDR_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when the resolution rubric, duration stratification, incident grouping, support-gate rules, or reviewer scoring/public audit contract changes."
      badgeClassName="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400"
      changelogClassName="hover:text-violet-700 dark:text-violet-400"
    >
      <p>
        When Pharos confirms an active depeg, the Depeg Duration Resolver answers two questions in order: will it come
        back, and if so, when. Stage 1 emits an ordinal Resolution Outlook &mdash; Recovery Likely, At Risk, Recovery
        Unlikely, or Insufficient Signal &mdash; from five kill signals (supply weaponization, backing impairment,
        freeze/seizure, reflexive death-spiral, exit collapse) and five recovery anchors (non-inflatable supply, hard
        collateral with live redemption, no supply anomaly, no single freeze point, proven mean-reversion), each shown
        with the factors that drove it.
      </p>
      <p>
        Stage 1 is a calibrated mechanistic rubric, not fitted machine learning. The terminal-label corpus is roughly
        90 mostly month-precision deaths that do not join to a clean feature vector at the depeg moment, so the
        thresholds are tuned and backtested against that corpus plus the recovered-event set rather than learned as
        weights. Verdicts are domain reads, never dressed up as probabilities.
      </p>
      <p>
        Stage 2 runs only when Stage 1 is not terminal-leaning. It is an empirical landmark-survival estimate over the
        clean corpus of recovered incidents, conditioned on the depeg&rsquo;s structural stratum (depth, direction,
        structural class, and peg currency) most-dependable-first. It reports a median time-to-repeg with an
        interquartile band plus per-horizon (6h / 24h / 7d / 30d) resolution probabilities, support-gated and
        Wilson-bounded so thin cells show their support state instead of a fabricated number.
      </p>
      <p>
        The Depeg Duration Resolver Reviewer (DDRR) is the companion audit layer. It stores DDR assessment checkpoints,
        scores the first checkpoint for each event under the current methodology against later canonical depeg-event
        outcomes, and surfaces two headline checks: recovery-likelihood accuracy and the average observed-minus-DDR
        recovery-duration error. Pending, insufficient-signal, and data-issue rows remain visible but are excluded from
        scored headline accuracy.
      </p>
      <p>
        DDR consumes the same confirmed depeg events as the detection pipeline; it does not run its own detection. It is
        a probabilistic estimate from historical data, not investment advice and not a credit rating &mdash; a Recovery
        Unlikely verdict is a structural read, not a guarantee, and vice versa.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Trigger", value: "Active confirmed depeg events (ended_at IS NULL), both directions" },
          { label: "Readouts", value: "DDR outlook/duration bands + DDRR recovery-likelihood and duration-error review" },
          { label: "Update frequency", value: "Precomputed in the sync-stablecoins flow; served from D1 cache" },
        ]}
      />
      <MethodologyDetails summary="Technical details: limitations and backtest gates">
        <div className="space-y-3">
          <p>
            Supply history is daily and mint/burn coverage is partial (about 141 of 399 coins), so coins with neither
            usable source degrade to Insufficient Signal on supply-dependent kill signals rather than guessing. The
            depeg-event provenance side-table is unpopulated in production, so audit-verdict gating is not used; corpus
            quality comes from incident grouping, quarantine of flappy coins, and a minimum-severity floor. Terminal
            truth derives from cemetery/frozen status and the live deep-and-sustained-open pattern, never from the
            presence of a recovery price on a backfilled row.
          </p>
          <p>
            Acceptance gates: Stage 1 must score Recovery Unlikely on clearly-attributable deaths (UST, IRON, USR) and
            must not on major recoveries (USDC during SVB, DAI on Black Thursday, LUSD/BOLD wobbles); Stage 2 median/IQR
            bands must contain realized resolution times at the documented coverage rate, with leave-one-coin stability
            and a stable canonical lineage hash. Abandoned slow-deaths that never present a sharp depeg are out of
            scope. The full methodology, limitations, and backtest plan live in docs/depeg-resolver.md.
          </p>
          <p>
            DDRR does not replay today&rsquo;s resolver over historical rows. It compares the stored DDR readout with the
            later event outcome, caps the public row sample while computing headline stats across the loaded current
            methodology ledger, and marks the snapshot degraded when that ledger is truncated or contains invalid rows.
          </p>
        </div>
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
