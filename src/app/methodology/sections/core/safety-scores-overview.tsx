import {
  METHODOLOGY_LINK_CLASS,
  MethodologyFacts,
} from "../../methodology-shared";

export function SafetyScoresOverview() {
  return (
    <>
      <p>
        Safety Score V9 is the active model for identity-aware consumers. It evaluates three material risk pillars:
        Backing (40%), Exit (35%), and Economic Control (25%). The aggregation allows bounded headroom above the
        weakest material path, then applies peg behavior, structural ceilings, evidence sufficiency, track record,
        dependencies, and wrapper-local risk. A strong unrelated pillar therefore cannot erase a weak material
        failure path.
      </p>
      <p>
        Exit selects the strongest exact same-notional route and may add a bounded independent-backup credit:
        {" "}<span className="font-mono">min(10, 100 - primary) × backup / 100</span>. The score card shows the
        selected route, backup credit, and actual stress-request completion separately. The standalone DEX market
        score and redemption route score describe their own modules; neither is the V9 Exit score.
      </p>
      <p>
        V9 distinguishes measured adverse evidence from issuer non-disclosure, unsupported methodology, missing
        integration, and transient producer failure. Bounded gaps can remain rateable under explicit ceilings; an
        unbounded required fact remains NR. F is reserved for causally attributed measured danger, while a D requires
        measured weakness or traceable policy-bounded uncertainty.
      </p>
      <p>
        Live reserve percentages are scoring weights, not identities. A namespace-qualified stable source key joins
        an adapter-owned reserve category to reviewed classification and dependency metadata across rebalancing or
        label changes. Explicit keys must match uniquely and otherwise fail closed; historical unkeyed captures retain
        a unique normalized-name compatibility join.
      </p>
      <p>
        Since methodology v9.31, curated collateral links share the reserve-envelope admission gate. When no live
        reserve slices exist and the curated composition is stale or otherwise inadmissible, the dependency overlay
        publishes no curated basket edges; the existing reserve-envelope gap carries the bounded consequence instead
        of an unrelated unreviewed-dependency reason. Admissible curated reviews, live-derived edges, and manual
        dependency reviews remain unchanged.
      </p>
      <p>
        Responsibility follows causal provenance instead of the nearest processing stage. An explicit reason-level
        owner is authoritative; inherited reserve gaps, unavailable upstream pillars, and missing parent scores carry
        every originating owner downstream. Every attributed root receives a causal-root-qualified score path even
        when it is the only root, so adding another root cannot rename an existing public fact; only unattributed
        fallbacks retain aggregate base paths, and ownership never becomes part of fact identity.
        Applicable but unpublished mechanism metrics remain issuer-undisclosed rather than measured-adverse. A
        reviewed external exit output whose identity is known but cannot be valued is attributed to producer failure,
        while an issuer-undisclosed settlement asset stays issuer-undisclosed; neither becomes scoreable. Date-only
        dispositions enter replay only after their reviewed UTC day. Partial control reviews retain the controls that
        were actually reviewed while unresolved surfaces remain bounded and fail closed. Strategy-vault wrapper
        loss-control facts can use those reviewed local controls as wrapper evidence, but risk-transfer credit remains
        zero unless a separate enforceable parent-loss backstop is reviewed. Subthreshold unrecognized chain-label
        supply pools are tolerated by the bridge-materiality proof and no longer surface as public
        evidence-responsibility facts; material unmatched bridge supply still fails closed. Coverage that no
        supported adapter can observe is unsupported methodology rather than producer failure: deployment census
        coverage is reported per chain instead of all or nothing, an exit surface whose census remainder is
        unsupported reports unsupported route evidence, and an unreviewed dependency set on an asset with no
        live-reserve adapter is unsupported rather than failed. Since methodology 9.2, a populated DEX exit
        surface is complete for gap accounting once its budgeted score-eligible routes are observed; leftover
        target-construction and reviewed model-limit gates on other recognised venues are not a data-feed
        failure. Exact-route scoring completeness stays strict. An asset with no usable price whose tracked peg
        record is already adverse is measured adverse, while a clean record with no usable price stays a quiet
        observation and its deviation is never coerced to zero. These are provenance and
        evidence-retention changes: pillar weights, score math, and grade thresholds are unchanged.
      </p>
      <p>
        Governance access posture treats a reviewed global mint-domain contract as immutable when it has no privileged
        capabilities, no applicable cap, no claim-impairment path, and access-only scope. A contract address alone
        identifies protocol machinery rather than a concentrated administrator; deployment-scoped bridge controls
        remain separate.
      </p>
      <p>
        Economic Control treats oracle applicability separately from oracle quality. A reviewed path with no
        price-sensitive oracle or internal valuation authority is not applicable and contributes no scored component.
        If no other binding control remains, the neutral empty set resolves to 95 without manufacturing a display row.
        A genuinely oracleless mechanism scores 95, while privileged internal pricing scores 45; a top-level mint,
        redemption, NAV, or exchange-rate authority can therefore be evaluated without inventing borrower liquidation
        branches. External oracle tiers keep their existing scores.
      </p>
      <p>
        Publication is fail-closed. Global, stale, or identity failures retain the last accepted V9 ratings and expose
        the publication as held. Attributable asset-local producer failures instead quarantine affected assets to NR
        and can publish while at least 90% of active assets remain unaffected. Active consumers do not recompute or
        fall back to V8.
      </p>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <a href="/methodology/scoring-changelog/" className={METHODOLOGY_LINK_CLASS}>Safety Score changelog</a>
        {" · "}
        <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>PegScore + DEWS</a>
        {" · "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
        {" · "}
        <a href="#infrastructure-methodology" className={METHODOLOGY_LINK_CLASS}>Infrastructure</a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "Model shape", value: "3 pillars + bounded aggregation" },
          { label: "Grade output", value: "A+ to F, with NR" },
          { label: "Publication state", value: "Current or held; never V8 fallback" },
        ]}
      />
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
        <MethodologyFacts
          facts={[
            { label: "Minimum data", value: "Mechanism-appropriate required facts for all material pillars" },
            { label: "Required sources", value: "Backing, exit, control, peg, dependency, and evidence-provenance inputs" },
            {
              label: "Failure behavior",
              value: "Unbounded evidence gaps return NR; transient producer failures hold the last accepted publication",
            },
          ]}
        />
      </div>
    </>
  );
}
