import { Suspense } from "react";
import type { Metadata } from "next";
import type { FaqItem } from "@/lib/faq";
import { buildLiveRouteOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import FlowsClient from "./client";
import { FlowsLoadingState } from "./loading-state";
import { DEFINITIONS } from "@/lib/definitions";

const FLOWS_DESCRIPTION =
  "Configured issuance-chain minting and redemption flows for tracked stablecoins. Net flow direction, pressure-vs-baseline signals, and the Bank Run Gauge.";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Mint/Burn Flows & Bank Run Gauge",
  description: FLOWS_DESCRIPTION,
  canonical: "/flows/",
  ogImage: buildLiveRouteOgImageUrl("flows"),
});

const FLOW_FAQ_ITEMS = [
  {
    question: "What is the Bank Run Gauge?",
    answer:
      DEFINITIONS.bankRunGauge.long,
  },
  {
    question: "What do mint and burn events indicate?",
    answer:
      "Mint and burn events measure token creation and destruction on each stablecoin's configured native issuance chain. They do not by themselves establish investor inflows or withdrawals: USDai, for example, can be burned when PYUSD is deployed into sUSDai loan positions without an equivalent loss of protocol assets. Individually reviewed protocol-internal events, such as USD.AI's September 23, 2026 loan-deployment burn, are excluded from counted flow. Other sustained net burn pressure feeds the Bank Run Gauge and DEWS, but its cause requires separate evidence.",
  },
  {
    question: "What does the pressure shift vs the 30-day norm mean?",
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
