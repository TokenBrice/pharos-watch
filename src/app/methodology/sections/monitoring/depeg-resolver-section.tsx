import { DDR_METHODOLOGY_CHANGELOG_PATH, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { MethodologyDetails, MethodologyFacts, MethodologySectionShell } from "../../methodology-shared";
import { DEPEG_RESOLVER_SECTION_CONTENT } from "@/lib/methodology-content";
import { METHODOLOGY_SECTION_ACCENT_CLASSES } from "@shared/lib/classification";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";

export function DepegResolverMethodologySection() {
  return (
    <MethodologySectionShell
      id={DEPEG_RESOLVER_SECTION_CONTENT.id}
      title={DEPEG_RESOLVER_SECTION_CONTENT.title}
      versionBadge={{
        label: DDR_METHODOLOGY_VERSION_LABEL,
      }}
      changelogPath={DDR_METHODOLOGY_CHANGELOG_PATH}
      versionNote="DDR v5 reads verdicts as evidence classes, publishes competing-risk recovery odds, and grades calls against naive baselines."
      changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.depegResolver.changelogHover}
    >
      <p>
        When Pharos confirms an active depeg, the Depeg Duration Resolver answers two questions in order at the public
        forecast lock: will it come back, and if so, when. Stage 1 emits an ordinal evidence class &mdash; No break
        signals, Stress signals, Terminal evidence, or Insufficient Signal &mdash; from six kill signals (supply
        weaponization, backing impairment, freeze/seizure, reflexive death-spiral, exit collapse, issuer wind-down), each
        shown with the factors that drove it. Five recovery anchors (non-inflatable supply, hard collateral with live
        redemption, no supply anomaly, no single freeze point, proven mean-reversion) are published as context and no
        longer gate a tier. Predictions sealed before v5 keep their original Recovery Likely, At Risk, and Recovery
        Unlikely labels.
      </p>
      <p>
        Terminal evidence means a terminal status, an announced issuer wind-down, any severe kill signal, or two or more
        kill signals without a strong structural anchor on a below-peg break deeper than 1,000 bps, measured as the worse
        of the stored peak and live deviation. Any other kill signal, or a deep below-peg break with none, reads as Stress
        signals. Static exit thinness &mdash; a thin route, no viable route, thin liquidity, or thin redemption capacity
        &mdash; caps at elevated: V9 exit capacity is measured against the dislocation&rsquo;s value gap (supply times
        break depth) instead of the Safety Score stress request and its $1M floor, which made small-float coins look
        exhausted in calm periods too. Exit collapse is severe only when DEX TVL falls at least 40% from the
        event&rsquo;s onset baseline on a thin market.
      </p>
      <p>
        DDR uses a forecast-readiness-or-72h public contract. Active confirmed incidents show live facts before the
        lock, then freeze exactly one official prediction or no-call on the first healthy run with readiness score
        strictly greater than 0.75, or on the first healthy run at or after the 72h backstop. Health failures defer the
        lock instead of creating a no-call, and later current-price movement is shown as live status beside the frozen
        prediction rather than rewriting it. Because more rows now read No break signals, some incidents reach
        readiness and lock earlier than they would have under v4; the lock rule itself is unchanged. New predictions
        also store the raw decision inputs read at the lock, with unavailable values kept distinct from zero, so later
        methodology changes can be replayed over sealed history.
      </p>
      <p>
        Stage 1 is a calibrated mechanistic rubric, not fitted machine learning. The terminal-label corpus is roughly 90
        mostly month-precision deaths that do not join to a clean feature vector at the depeg moment, so the thresholds
        are tuned and backtested against that corpus, DDRR reviewed outcomes, and the recovered-event set rather than
        learned as weights. DDRv4 added issuer wind-down evidence, mechanism-gated backing impairment, V9 grade context,
        and event-time mint/burn context to the terminality read. Forecast readiness is a publication trigger, not a
        probability or confidence level. Structural mint risk reads the published Safety Score mint posture, with
        curated fallback when unavailable. A finding of no mint authority on a wrapper does not establish that its
        parent supply cannot expand.
      </p>
      <p>
        Recovery-anchor evidence requires measured event-time supply and onset, a valid seven-day comparison and
        affirmative non-anomaly proof; missing evidence is unavailable, not a post-onset substitute. Training and
        live duration strata share run-local admitted mint posture. Overlapping and nested intervals use a
        monotonic union with open-member dominance, terminal-boundary closure ownership and conservative equal-end
        ties. Later freezes cannot relabel earlier recoveries; coarse day/month evidence must be fully settled
        before overriding a measured recovery. Frozen forecasts retain their original contents and identity.
      </p>
      <p>
        Stage 2 runs only when Stage 1 is not Terminal evidence. It is an empirical landmark estimate of recovery odds
        over the clean incident corpus, conditioned on the depeg&rsquo;s structural stratum (depth, direction,
        structural class, and peg currency) most-dependable-first. Labels follow canonical incident grouping. Since v5
        the odds are unconditional: comparable incidents that ended terminal count as a competing outcome that never
        recovers, still-open and non-recovery closures are censored at their last observation, and each coin carries at
        most one unit of weight (a coin-weighted Aalen&ndash;Johansen estimate). The median time-to-repeg and typical
        range (15th-85th percentile) are read off that recovery curve and stay empty when it never reaches them, and
        the share not recovered within 30 days is published. Per-horizon (6h / 24h / 7d / 30d) cells are support-gated
        on incidents whose outcome at that horizon is already known and Wilson-bounded, so thin cells show their support
        state instead of a fabricated number; a horizon that fails the replay skill gate is shown as not informative.
        Predictions sealed before v5 estimated duration conditional on recovery and keep that meaning.
      </p>
      <p>
        Duration history uses only timed onset and current-deviation observations, never a final peak backdated into
        an earlier landmark. Sparse or missing timed evidence can suppress duration bands until recalibration.
        These input-admission changes can move new assessments and forecast verdicts; already sealed predictions
        keep their original values and version stamps. Nominal prices and unavailable or nonpositive supply cannot
        manufacture an at-peg live input.
      </p>
      <p>
        Seven-day and 30-day TVL trends compare the stored current and historical liquidity-measurement epochs,
        not exact minor-version labels. A cross-epoch baseline is unavailable evidence, not an observed exit
        collapse. Independent liquidity scores and volume trends remain usable. This can change new assessments
        and future forecasts, never already sealed predictions or their first-publication payloads.
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
        Reviewer v5 grades calls against naive baselines: recovery-call accuracy beside what a constant &ldquo;will
        recover&rdquo; forecaster would score, terminal-call counts beside terminal outcomes, and horizon Brier skill
        against a leave-one-out base rate. Duration error adds a median log ratio and a within-2x count, which long
        incidents cannot dominate. A still-open incident already past its published band is graded slower than band.
        Terminal evidence that was settled before the lock is counted as curation debt, not a forecast miss. Frozen
        v2-v4 predictions keep their contents, hashes, and methodology, but these rules can reclassify their outcomes.
      </p>
      <p>
        Reviewer accuracy can switch to the current prediction policy without narrowing whole-universe coverage or
        hiding missed locks and publication debt. Per-coin counts and duration errors come from producer aggregates
        computed before the browse-row cap. Retained snapshots without those aggregates show unavailable until a
        refresh, not a track record reconstructed from the displayed sample.
      </p>
      <p>
        DDR consumes the same confirmed depeg events as the detection pipeline; it does not run its own detection. It is
        a forecast from historical data, not investment advice and not a credit rating &mdash; a Terminal evidence
        verdict is a structural read, not a guarantee, and vice versa.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Trigger", value: "Forecast readiness >0.75 or first healthy run at/after 72h" },
          { label: "Readouts", value: "Immutable DDR forecasts/no-calls + DDRR coverage and first-publication review" },
          { label: "Update frequency", value: `Precomputed by the dedicated compute-depeg-resolver scheduled producer every ${CRON_INTERVALS["compute-depeg-resolver"] / 60} minutes; served from D1 cache` },
        ]}
      />
      <MethodologyDetails summary="Technical details: limitations and backtest gates">
        <div className="space-y-3">
          <p>
            Supply history is daily and mint/burn coverage is partial (about 141 of 400 coins), so coins with neither
            usable source degrade to Insufficient Signal on supply-dependent kill signals rather than guessing.
            Legacy null audit verdicts remain eligible; false-positive, disputed, no-data, and unknown non-null
            verdicts are excluded. Corpus quality also depends on incident grouping, quarantine of flappy coins,
            and a minimum-severity floor. Terminal
            truth derives from cemetery/frozen status and the live deep-and-sustained-open pattern, never from the
            presence of a recovery price on a backfilled row.
          </p>
          <p>
            Acceptance gates: Stage 1 must score Terminal evidence on clearly-attributable deaths (UST, IRON, USR) and
            must not on major recoveries (USDC during SVB, DAI on Black Thursday, LUSD/BOLD wobbles); Stage 2 median and
            typical ranges must contain realized resolution times at the documented coverage rate, with leave-one-coin stability
            and a stable canonical lineage hash. Abandoned slow-deaths that never present a sharp depeg are out of
            scope. The full methodology, limitations, and backtest plan live in docs/depeg-resolver.md.
          </p>
          <p>
            v5 replay evidence is small and advisory. Re-mapping 74 forecast-scored sealed outcomes under the v5 rules
            gave 71 correct calls against 61 under v4 and 70 for a constant &ldquo;will recover&rdquo; baseline, with
            false terminal calls falling from 11 to 1. A time-ordered duration replay (46 to 121 incidents per landmark)
            lowered Brier error against v4 in every landmark and horizon cell and beat a pooled base rate per horizon,
            but odds remain overconfident at long horizons (30-day odds averaged 0.90 against 0.79 observed at the
            1-hour landmark) and typical-range coverage stays below its nominal 70%. Terminal-call skill cannot yet be
            measured: only three forward-looking terminal outcomes exist.
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
