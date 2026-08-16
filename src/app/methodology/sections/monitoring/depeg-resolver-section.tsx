import { DDR_METHODOLOGY_CHANGELOG_PATH, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { MethodologyDetails, MethodologyFacts, MethodologySectionShell } from "../../methodology-shared";
import { DEPEG_RESOLVER_SECTION_CONTENT } from "@/lib/methodology-content";

export function DepegResolverMethodologySection() {
  return (
    <MethodologySectionShell
      id={DEPEG_RESOLVER_SECTION_CONTENT.id}
      title={DEPEG_RESOLVER_SECTION_CONTENT.title}
      versionBadge={{
        label: DDR_METHODOLOGY_VERSION_LABEL,
      }}
      changelogPath={DDR_METHODOLOGY_CHANGELOG_PATH}
      versionNote="DDR v4 updates the resolution rubric, duration landmarks, incident lifecycle, support gates, and reviewer audit contract."
      changelogClassName="hover:text-violet-700 dark:hover:text-violet-400"
    >
      <p>
        When Pharos confirms an active depeg, the Depeg Duration Resolver answers two questions in order at the public
        forecast lock: will it come back, and if so, when. Stage 1 emits an ordinal Resolution Outlook &mdash; Recovery
        Likely, At Risk, Recovery Unlikely, or Insufficient Signal &mdash; from five kill signals (supply weaponization,
        backing impairment, freeze/seizure, reflexive death-spiral, exit collapse) and five recovery anchors
        (non-inflatable supply, hard collateral with live redemption, no supply anomaly, no single freeze point, proven
        mean-reversion), each shown with the factors that drove it.
      </p>
      <p>
        DDRv4 uses a forecast-readiness-or-72h public contract. Active confirmed incidents show live facts before the
        lock, then freeze exactly one official prediction or no-call on the first healthy run with readiness score
        strictly greater than 0.75, or on the first healthy run at or after the 72h backstop. Health failures defer the
        lock instead of creating a no-call, and later current-price movement is shown as live status beside the frozen
        prediction rather than rewriting it.
      </p>
      <p>
        Stage 1 is a calibrated mechanistic rubric, not fitted machine learning. The terminal-label corpus is roughly 90
        mostly month-precision deaths that do not join to a clean feature vector at the depeg moment, so the thresholds
        are tuned and backtested against that corpus, DDRR reviewed outcomes, and the recovered-event set rather than
        learned as weights. DDRv4 adds issuer wind-down evidence, mechanism-gated backing impairment, V9 grade context,
        and event-time mint/burn context to the terminality read. Forecast readiness is a publication trigger, not a
        probability or confidence level.
      </p>
      <p>
        Stage 2 runs only when Stage 1 is not terminal-leaning. It is an empirical landmark-survival estimate over the
        clean corpus of recovered incidents, conditioned on the depeg&rsquo;s structural stratum (depth, direction,
        structural class, and peg currency) most-dependable-first. Labels follow canonical incident grouping, and
        comparable histories are deduplicated by coin. It reports a median time-to-repeg with a typical range
        (15th-85th percentile) plus per-horizon (6h / 24h / 7d / 30d) resolution-likelihood cells, support-gated and
        Wilson-bounded so thin cells show their support state instead of a fabricated number.
      </p>
      <p>
        The Depeg Duration Resolver Reviewer (DDRR) is the companion audit layer. It scores only frozen outcomes that
        reached first publication, while coverage metrics keep no-calls, pre-lock recoveries, missed locks, publication
        retries/failures, data-quality gaps, and invalidated predictions visible. Recovery-likelihood and duration
        accuracy are computed only where a public frozen prediction can fairly be reviewed. Rollout-active incidents
        that predate the DDRv2 public contract use that public-contract boundary for coverage classification, so
        historical terminal evidence is not counted as live missed-lock debt, and old sticky 24h policy rows remain
        auditable with their original lock metadata. Review rows also retain repaired and regime-split lineage, with
        expected-versus-observed horizon calibration shown alongside realized outcomes.
      </p>
      <p>
        DDR consumes the same confirmed depeg events as the detection pipeline; it does not run its own detection. It is
        a forecast from historical data, not investment advice and not a credit rating &mdash; a Recovery Unlikely
        verdict is a structural read, not a guarantee, and vice versa.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Trigger", value: "Forecast readiness >0.75 or first healthy run at/after 72h" },
          { label: "Readouts", value: "Immutable DDR forecasts/no-calls + DDRR coverage and first-publication review" },
          { label: "Update frequency", value: "Precomputed in the sync-stablecoins flow; served from D1 cache" },
        ]}
      />
      <MethodologyDetails summary="Technical details: limitations and backtest gates">
        <div className="space-y-3">
          <p>
            Supply history is daily and mint/burn coverage is partial (about 141 of 400 coins), so coins with neither
            usable source degrade to Insufficient Signal on supply-dependent kill signals rather than guessing. The
            depeg-event provenance side-table is unpopulated in production, so audit-verdict gating is not used; corpus
            quality comes from incident grouping, quarantine of flappy coins, and a minimum-severity floor. Terminal
            truth derives from cemetery/frozen status and the live deep-and-sustained-open pattern, never from the
            presence of a recovery price on a backfilled row.
          </p>
          <p>
            Acceptance gates: Stage 1 must score Recovery Unlikely on clearly-attributable deaths (UST, IRON, USR) and
            must not on major recoveries (USDC during SVB, DAI on Black Thursday, LUSD/BOLD wobbles); Stage 2 median and
            typical ranges must contain realized resolution times at the documented coverage rate, with leave-one-coin stability
            and a stable canonical lineage hash. Abandoned slow-deaths that never present a sharp depeg are out of
            scope. The full methodology, limitations, and backtest plan live in docs/depeg-resolver.md.
          </p>
          <p>
            DDRR does not replay today&rsquo;s resolver over historical rows. It compares the frozen first-published DDR
            outcome with the later event outcome, keeps append-only errata visible, preserves immutable
            trigger/readiness metadata, and separates policy-universe coverage from scoreable recovery/duration
            accuracy. If a health deferral is followed by recovery or reliable terminal evidence before a healthy lock,
            the row remains a pre-lock coverage outcome rather than a retroactive forecast. Rollout-active incidents
            that already existed before DDRv2 use the public-contract effective timestamp as the fairness boundary for
            the same pre-lock coverage test.
          </p>
        </div>
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
