import type { Metadata } from "next";
import type { FaqItem } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import StatusClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos System Status: API Health & Data Freshness",
  description:
    "Public Pharos system status for dashboard health, API availability, cache freshness, endpoint probes, circuit breakers, and recent incidents.",
  canonical: "/status/",
});

const STATUS_FAQ_ITEMS = [
  {
    question: "What does System Status monitor?",
    answer:
      "System Status monitors public Pharos health, cache freshness, endpoint probes, circuit-breaker state, and recent status transitions. It is the public view of whether the dashboard and data API are serving fresh enough information.",
  },
  {
    question: "Why can status differ from a single endpoint response?",
    answer:
      "The status page blends cache freshness, Worker health, browser reachability probes, and incident history. A single endpoint can be slow or stale while the overall system remains available, or the aggregate can degrade when several public data lanes drift together.",
  },
  {
    question: "How often should I refresh the status page?",
    answer:
      "Manual refresh is enough for most users. Public status data is cached on short intervals, and external integrations should rely on API response headers, Retry-After, and endpoint-specific polling guidance instead of aggressively refreshing this page.",
  },
] as const satisfies readonly FaqItem[];

export default function StatusPage() {
  return <StatusClient faqItems={STATUS_FAQ_ITEMS} />;
}
