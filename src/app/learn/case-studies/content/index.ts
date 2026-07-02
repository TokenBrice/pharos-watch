import type { CaseStudy } from "./types";
import {
  resolveCaseStudySlugForEvent,
  type CaseStudyEventWindowResolverItem,
} from "./event-window-resolver";
import { content as usdcSvb2023 } from "./usdc-svb-2023";
import { content as terraUst2022 } from "./terra-ust-2022";
import { content as daiBlackThursday } from "./dai-black-thursday";
import { content as usdeOracle2025 } from "./usde-oracle-2025";
import { content as buidlTokenizedTbill2025 } from "./buidl-tokenized-tbill-2025";
import { content as usycNavPricing2025 } from "./usyc-nav-pricing-2025";
import { content as usd0ppUsual2025 } from "./usd0pp-usual-2025";
import { content as crvusdExploitTrilogy } from "./crvusd-exploit-trilogy";
import { content as ironTitan2021 } from "./iron-titan-2021";
import { content as feiProtocol } from "./fei-protocol";
import { content as usrResolv2026 } from "./usr-resolv-2026";
import { content as pmusdPreciousMetals } from "./pmusd-precious-metals";
import { content as apxusdDatCollateral } from "./apxusd-dat-collateral";
import { content as lusdFlightToSafety2023 } from "./lusd-flight-to-safety-2023";
import { content as streamElixirContagion2025 } from "./stream-elixir-contagion-2025";
import { content as busdPaxos2023 } from "./busd-paxos-2023";
import { content as multichainUsdc2023 } from "./multichain-usdc-2023";
import { content as eurtMicaExit2024 } from "./eurt-mica-exit-2024";
import { content as maiQidaoBridge2023 } from "./mai-qidao-bridge-2023";
import { content as susdSip4202025 } from "./susd-sip420-2025";
import { content as fdusdSunFdt2025 } from "./fdusd-sun-fdt-2025";
import { content as usdfFalcon2025 } from "./usdf-falcon-2025";
import { content as usdnNeutrino2022 } from "./usdn-neutrino-2022";
import { content as usdxKava2022 } from "./usdx-kava-2022";
import { content as ftxContagion2022 } from "./ftx-contagion-2022";
import { content as usddTronReserve2024 } from "./usdd-tron-reserve-2024";
import { content as usdrRealUsd2023 } from "./usdr-real-usd-2023";

/**
 * Canonical display + sitemap order. Tier 1 (one per archetype, marquee) first,
 * then Tier 2. The hub grid and `generateStaticParams` both follow this order.
 */
export const CASE_STUDY_LIST: readonly CaseStudy[] = [
  usdcSvb2023,
  lusdFlightToSafety2023,
  terraUst2022,
  daiBlackThursday,
  usdeOracle2025,
  buidlTokenizedTbill2025,
  usycNavPricing2025,
  usd0ppUsual2025,
  crvusdExploitTrilogy,
  susdSip4202025,
  ironTitan2021,
  usdnNeutrino2022,
  feiProtocol,
  usrResolv2026,
  streamElixirContagion2025,
  usdfFalcon2025,
  fdusdSunFdt2025,
  busdPaxos2023,
  multichainUsdc2023,
  ftxContagion2022,
  usdrRealUsd2023,
  eurtMicaExit2024,
  usddTronReserve2024,
  usdxKava2022,
  maiQidaoBridge2023,
  pmusdPreciousMetals,
  apxusdDatCollateral,
];

export const CASE_STUDIES: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.map((study) => [study.slug, study]),
);

export function getCaseStudy(slug: string): CaseStudy | undefined {
  return CASE_STUDIES[slug];
}

/** Reverse lookups so other surfaces can link inward to a coin's / event's study. */
export const CASE_STUDY_BY_COIN_ID: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.filter((s) => s.primaryCoinId).map((s) => [s.primaryCoinId!, s]),
);

export const CASE_STUDY_BY_DEPEG_SLUG: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.filter((s) => s.depegEventSlug).map((s) => [s.depegEventSlug!, s]),
);

const CASE_STUDY_EVENT_WINDOWS: readonly CaseStudyEventWindowResolverItem[] = CASE_STUDY_LIST.map(
  (study) => ({
    slug: study.slug,
    primaryCoinId: study.primaryCoinId ?? null,
    relatedCoinIds: (study.relatedCoins ?? []).map((coin) => coin.coinId),
    startISO: study.eventWindow.startISO,
    endISO: study.eventWindow.endISO ?? null,
  }),
);

/**
 * Server-side resolver for surfaces that already import the full content
 * registry. Client chart overlays import the generated implementation from
 * `client-index.ts` instead, so article prose stays out of charted bundles.
 */
export function caseStudySlugForEvent(coinId: string, tsMs: number): string | undefined {
  return resolveCaseStudySlugForEvent(CASE_STUDY_EVENT_WINDOWS, coinId, tsMs);
}

export type { CaseStudy } from "./types";
