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
        V9 distinguishes measured adverse evidence from issuer non-disclosure, unsupported methodology, missing
        integration, and transient producer failure. Bounded gaps can remain rateable under explicit ceilings; an
        unbounded required fact remains NR. F is reserved for causally attributed measured danger, while a D requires
        measured weakness or traceable policy-bounded uncertainty.
      </p>
      <p>
        Responsibility follows causal provenance instead of the nearest processing stage. An explicit reason-level
        owner is authoritative; inherited reserve gaps, unavailable upstream pillars, and missing parent scores carry
        every originating owner downstream. The aggregate base path remains stable while additional mixed roots
        receive causal-root-qualified score paths; ownership never becomes part of fact identity.
        Applicable but unpublished mechanism metrics remain issuer-undisclosed rather than measured-adverse. A
        reviewed external exit output whose identity is known but cannot be valued is attributed to producer failure,
        while an issuer-undisclosed settlement asset stays issuer-undisclosed; neither becomes scoreable. Date-only
        dispositions enter replay only after their reviewed UTC day. Partial control reviews retain the controls that
        were actually reviewed while unresolved surfaces remain bounded and fail closed. These are provenance and
        evidence-retention changes: pillar weights, score math, and grade thresholds are unchanged.
      </p>
      <p>
        Governance access posture treats a reviewed global mint-domain contract as immutable when it has no privileged
        capabilities, no applicable cap, no claim-impairment path, and access-only scope. A contract address alone
        identifies protocol machinery rather than a concentrated administrator; deployment-scoped bridge controls
        remain separate.
      </p>
      <p>
        Publication is fail-closed. If a score-bearing producer is stale, unavailable, or would create a new
        infrastructure-attributed downgrade or NR transition, Pharos retains the last accepted V9 ratings and exposes
        the publication as held. Active consumers do not recompute or fall back to V8.
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
