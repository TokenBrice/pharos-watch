import type { CaseStudy } from "./types";
import {
  resolveCaseStudySlugForEvent,
  type CaseStudyEventWindowResolverItem,
} from "@/lib/case-study-event-window";
import usdcSvb2023 from "./usdc-svb-2023.json";
import terraUst2022 from "./terra-ust-2022.json";
import daiBlackThursday from "./dai-black-thursday.json";
import usdeOracle2025 from "./usde-oracle-2025.json";
import buidlTokenizedTbill2025 from "./buidl-tokenized-tbill-2025.json";
import usycNavPricing2025 from "./usyc-nav-pricing-2025.json";
import usd0ppUsual2025 from "./usd0pp-usual-2025.json";
import crvusdExploitTrilogy from "./crvusd-exploit-trilogy.json";
import ironTitan2021 from "./iron-titan-2021.json";
import feiProtocol from "./fei-protocol.json";
import usrResolv2026 from "./usr-resolv-2026.json";
import pmusdPreciousMetals from "./pmusd-precious-metals.json";
import apxusdDatCollateral from "./apxusd-dat-collateral.json";
import lusdFlightToSafety2023 from "./lusd-flight-to-safety-2023.json";
import streamElixirContagion2025 from "./stream-elixir-contagion-2025.json";
import busdPaxos2023 from "./busd-paxos-2023.json";
import multichainUsdc2023 from "./multichain-usdc-2023.json";
import eurtMicaExit2024 from "./eurt-mica-exit-2024.json";
import maiQidaoBridge2023 from "./mai-qidao-bridge-2023.json";
import susdSip4202025 from "./susd-sip420-2025.json";
import fdusdSunFdt2025 from "./fdusd-sun-fdt-2025.json";
import usdfFalcon2025 from "./usdf-falcon-2025.json";
import usdnNeutrino2022 from "./usdn-neutrino-2022.json";
import usdxKava2022 from "./usdx-kava-2022.json";
import ftxContagion2022 from "./ftx-contagion-2022.json";
import usddTronReserve2024 from "./usdd-tron-reserve-2024.json";
import usdrRealUsd2023 from "./usdr-real-usd-2023.json";

/**
 * Canonical display + sitemap order. Tier 1 (one per archetype, marquee) first,
 * then Tier 2. The hub grid and `generateStaticParams` both follow this order.
 */
export const CASE_STUDY_LIST = [
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
] as readonly CaseStudy[];

export const CASE_STUDY_OUTCOME_COUNTS: Readonly<Record<CaseStudy["outcome"], number>> =
  CASE_STUDY_LIST.reduce(
    (counts, study) => ({ ...counts, [study.outcome]: counts[study.outcome] + 1 }),
    { survived: 0, wounded: 0, died: 0 },
  );

export const CASE_STUDIES: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.map((study) => [study.slug, study]),
);

/** Reverse lookups so other surfaces can link inward to a coin's / event's study. */
export const CASE_STUDY_BY_DEPEG_SLUG: Record<string, CaseStudy> = Object.fromEntries(
  CASE_STUDY_LIST.filter((s) => s.depegEventSlug).map((s) => [s.depegEventSlug!, s]),
);

const CASE_STUDY_EVENT_WINDOWS: readonly CaseStudyEventWindowResolverItem[] =
  CASE_STUDY_LIST.flatMap((study) =>
    (study.eventWindows ?? [study.eventWindow]).map((window) => ({
      slug: study.slug,
      primaryCoinId: study.primaryCoinId ?? null,
      relatedCoinIds:
        window.relatedCoinIds ??
        (study.relatedCoins ?? []).map((coin) => coin.coinId),
      startISO: window.startISO,
      endISO: window.endISO ?? null,
    })),
  );

/**
 * General server-side event resolver for surfaces that already import the
 * full content registry. The client chart-overlay resolver is retired;
 * ordinary case-study evidence and event-window matching remain.
 */
export function caseStudySlugForEvent(coinId: string, tsMs: number): string | undefined {
  return resolveCaseStudySlugForEvent(CASE_STUDY_EVENT_WINDOWS, coinId, tsMs);
}

export type { CaseStudy } from "./types";
