import {
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { EXIT_ROUTE_SCORING_TABLES } from "@shared/lib/exit-route-scoring";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
} from "../../methodology-shared";
import { REDEMPTION_BACKSTOP_SECTION_CONTENT } from "@/lib/methodology-content";

export function RedemptionBackstopMethodologySection() {
  const weights = EXIT_ROUTE_SCORING_TABLES.componentWeights;
  const request = EXIT_ROUTE_SCORING_TABLES.request;

  return (
    <MethodologySectionShell
      id={REDEMPTION_BACKSTOP_SECTION_CONTENT.id}
      title={REDEMPTION_BACKSTOP_SECTION_CONTENT.title}
      versionBadge={{ label: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL }}
      changelogPath={REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH}
      versionNote="The standalone route score and V9 Exit share scoring primitives but ask different capacity requests."
      changelogClassName="hover:text-emerald-700 dark:hover:text-emerald-400"
    >
      <p>
        The Redemption Backstop score rates one issuer or protocol redemption route from 0 to 100. It is a standalone
        route diagnostic, separate from Safety Score V9 Exit. Both consume the same reviewed access, settlement,
        execution, capacity, output, and cost primitives; V9 re-evaluates exact same-notional evidence under its own
        stress request, evidence ceilings, danger interlocks, and redundancy policy.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Version", value: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL },
          { label: "Output", value: "0–100 route score; null when required route evidence cannot resolve" },
          { label: "V9 relationship", value: "Shared primitives, independent V9 Exit evaluation" },
        ]}
      />
      <MethodologyDetails summary="Current route-score formula" primary>
        <p className="pharos-numeric">
          route = access × {weights.access} + settlement × {weights.settlement} + execution ×{" "}
          {weights.executionCertainty} + capacity × {weights.capacity} + output × {weights.outputAssetQuality} + cost
          × {weights.cost}
        </p>
        <p>
          The capacity component blends percent-of-supply coverage with absolute executable dollars. The standalone
          modeled request is {request.supplyRatio * 100}% of supply, floored at ${request.floorUsd.toLocaleString()}
          and capped at ${request.capUsd.toLocaleString()}. A measured zero-capacity route, or a positive route below
          both the 1% completion and $100,000 absolute breakpoints, receives a zero headline; missing capacity remains
          unrated; the same gate applies to the eventual-redeemability headline. Reviewed settlement terms are shared
          with V9, favorable corrections retain the 365-day evidence expiry, and reserve-sync full-supply eventual
          capacity requires an explicit dated evidence opt-in. On-chain formula-rate probes pin their return-value decimal
          scale before fresh fees can enter scoring. Route-family ceilings, holder eligibility, delay, queue,
          minimum-redemption, severe-depeg, freshness, and evidence rules can only reduce or withhold the result.
        </p>
        <MethodologyFacts
          facts={[
            { label: "Access", value: `${weights.access * 100}%` },
            { label: "Settlement", value: `${weights.settlement * 100}%` },
            { label: "Execution certainty", value: `${weights.executionCertainty * 100}%` },
            { label: "Capacity", value: `${weights.capacity * 100}%` },
            { label: "Output quality", value: `${weights.outputAssetQuality * 100}%` },
            { label: "Cost", value: `${weights.cost * 100}%` },
          ]}
        />
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
