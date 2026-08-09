import { Suspense } from "react";
import type { Metadata } from "next";
import type { FaqItem } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import FlowsClient from "./client";
import { FlowsLoadingState } from "./loading";

const FLOWS_DESCRIPTION =
  "Configured issuance-chain minting and redemption flows for tracked stablecoins. Net flow direction, pressure-vs-baseline signals, and the Bank Run Gauge.";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Mint/Burn Flows & Bank Run Gauge",
  description: FLOWS_DESCRIPTION,
  canonical: "/flows/",
  ogImage: `${SITE_URL}/og-flows.png`,
});

const FLOW_FAQ_ITEMS = [
  {
    question: "What is the Bank Run Gauge?",
    answer:
      "The Bank Run Gauge is a market-cap-weighted composite of each tracked stablecoin's pressure shift versus its own trailing 30-day issuance-chain baseline. It is a signed -100 to +100 pressure signal, not a literal mint-versus-burn direction meter. Scores below -10 indicate worsening redemption pressure across tracked canonical issuance flows, while scores above +10 indicate improving issuance pressure versus baseline. It returns null only when all tracked coins lack sufficient history or current activity.",
  },
  {
    question: "What do mint and burn events indicate?",
    answer:
      "On this page, mint and burn events reflect tracked issuance and redemption activity on each stablecoin's configured native issuance chain. Minting events signal new demand or capital inflow, while burn events signal redemption or outflow. Sustained net burn pressure above baseline levels can indicate early bank-run dynamics and is factored into the Bank Run Gauge and DEWS early warning signals.",
  },
  {
    question: "What does Pressure Shift vs 30D mean?",
    answer:
      "Pressure Shift vs 30D measures how unusual a coin's current 24-hour net flow is relative to its trailing 30 fully closed daily issuance-chain baseline. It uses the existing Flow Intensity formula: intensity = clamp(-100, 100, z × 50), where z = (currentDailyNet − baselineDailyNet) / max(baselineDailyAbs × 0.3, $1M). A score near 0 means flows match the baseline, negative scores mean pressure is worse than normal, and positive scores mean pressure is improving versus normal. Net flow direction still comes from the raw 24-hour mint-minus-burn value.",
  },
] as const satisfies readonly FaqItem[];

export default function FlowsPage() {
  return (
    <Suspense fallback={<FlowsLoadingState />}>
      <FlowsClient faqItems={FLOW_FAQ_ITEMS} />
    </Suspense>
  );
}
