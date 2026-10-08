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
      versionNote="The standalone route score and V10 Exit share scoring primitives but ask different capacity requests."
      changelogClassName="hover:text-emerald-700 dark:hover:text-emerald-400"
    >
      <p>
        The Redemption Backstop score rates one issuer or protocol redemption route from 0 to 100. It is a standalone
        route diagnostic, separate from Safety Score V10 Exit. Both consume the same reviewed access, settlement,
        execution, capacity, output, and cost primitives; V10 re-evaluates exact same-notional evidence under its own
        stress request, evidence ceilings, danger interlocks, and redundancy policy.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Version", value: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL },
          { label: "Output", value: "0–100 route score; null when required route evidence cannot resolve" },
          { label: "V10 relationship", value: "Shared primitives, independent V10 Exit evaluation" },
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
          with V10, favorable corrections retain the 365-day evidence expiry, and reserve-sync full-supply eventual
          capacity requires an explicit dated evidence opt-in. On-chain formula-rate probes pin their return-value decimal
          scale before fresh fees can enter scoring. Route-family ceilings, holder eligibility, delay, queue,
          minimum-redemption, severe-depeg, freshness, and evidence rules can only reduce or withhold the result. An open
          downside incident is market-implied degraded only when a fresh authoritative current signed deviation remains
          at or below -2500 bps; if current evidence cannot be established, the route is unknown and its score is
          withheld rather than inferred from the incident&apos;s historical peak. HBD&apos;s no-extra-fee conversion
          statement does not establish full-value proceeds under the protocol haircut, so its documented cost
          remains disclosed but unquantified until executable output value is established.
        </p>
        <p>
          Reserve-backed observations keep the validated source time, or the producing snapshot&apos;s fetch time
          for same-run on-chain and API evidence, separate from publication time. Republishing retained evidence
          does not reset its age or V10&apos;s eight-hour redemption evidence budget. Capacity percentages divide
          finalized executable dollars by the same positive current supply, including daily scoring bounds;
          issuer-reported ratios cannot override that denominator.
        </p>
        <p>
          Morpho Vault V2 capacity requires a same-run read of the exact vault&apos;s selected liquidity adapter;
          a zero or unreadable adapter permits only independently measured fresh idle underlying. Generic ERC-4626
          balances denominated outside USD require same-path FX valuation before they can become dollar capacity;
          otherwise capacity is unavailable while reserve evidence is retained. Newly reviewed routes do not turn
          unmeasured liquidity into a fixed zero: absent telemetry remains unrated, and routes without an honest
          capacity model remain source-reviewed but unconfigured.
        </p>
        <p>
          Direct executable observers are a separate route-evidence source, not proof of reserve composition.
          Lido, Monetrix and Saturn retain diagnostic-only null capacity; USDfr measures a restricted par-state
          USDC controller, and apyUSD measures funded apxUSD receipts only with current payout valuation.
          Delayed apyUSD receipts remain eventual-only, not immediate liquidity. Missing completion, exact output
          or all-in cost evidence cannot be replaced by full supply, vault NAV or idle cash. Reservoir&apos;s
          three routes share one USDC PSM resource rather than additive backup liquidity.
        </p>
        <p>
          A fee minimum is not a maximum, and zero issuer fees do not establish zero bank, network or partner
          deductions or full net proceeds. Each request point keeps its own cost. Settlement ceilings require
          dated support for completed payout; processing targets, cooldowns and conditional business-day terms
          remain gaps. The supply-cache generation must pass its existing availability budget before a new
          snapshot is built. Original reserve freshness and immutable details fail closed; older valid fallback
          keeps its own clock rather than appearing newly observed.
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
