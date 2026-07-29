import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { MethodologySectionShell } from "../../methodology-shared";
import { LIQUIDITY_SECTION_CONTENT } from "../methodology-content";
import { LiquidityTechnicalDetails } from "./liquidity-technical-details";
import { LiquidityOverview, LiquidityPreconditions } from "./liquidity-overview";
import { LiquidityPoolMatchingDetails } from "./liquidity-pool-matching-details";
import { LiquidityWorkedExample } from "./liquidity-worked-example";

export function LiquidityMethodologySection() {
  return (
    <MethodologySectionShell
      id={LIQUIDITY_SECTION_CONTENT.id}
      title={LIQUIDITY_SECTION_CONTENT.title}
      versionBadge={{ label: LIQUIDITY_METHODOLOGY_VERSION_LABEL }}
      changelogPath={LIQUIDITY_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when liquidity formula weights, source inclusion rules, or TVL normalization logic changes."
      changelogClassName="hover:text-sky-700 dark:hover:text-sky-400"
    >
      <LiquidityOverview />
      <LiquidityPoolMatchingDetails />
      <LiquidityPreconditions />
      <LiquidityWorkedExample />
      <LiquidityTechnicalDetails />
    </MethodologySectionShell>
  );
}
