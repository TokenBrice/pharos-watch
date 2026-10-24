import type { Metadata } from "next";
import type { FaqItem } from "@/lib/faq";
import { buildPageMetadata } from "@/lib/page-metadata";
import StatusClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "System Status: API Health & Data Freshness",
  description:
    "Public Pharos system status for dashboard health, API availability, cache freshness, endpoint probes, circuit breakers, and recent incidents.",
  canonical: "/status/",
});

const STATUS_FAQ_ITEMS = [
  {
    question: "What does System Status monitor?",
    answer:
      "System Status shows each public Pharos component, such as the website and API, stablecoin prices, charts, Safety Scores, risk signals and event feeds, with its current state and 30 days of history. A day is coloured only when a problem lasted an hour or more that day, or any outage occurred; shorter blips are listed in the day's tooltip. Safety Scores are graded by the age of the last accepted scores; a held publication is shown as a notice while those scores stay inside their freshness budget. History before a component began being monitored is unknown, not operational.",
  },
  {
    question: "Why can status differ from a single endpoint response?",
    answer:
      "Each component is graded against its own freshness budget: Delayed past the first budget, Degraded past the stale limit, and Outage only once the data has stayed stale for a further grace period or a core check fails. A single endpoint can be slow or stale while its component stays inside budget. The probes and cache tables under For integrators show the raw readings.",
  },
  {
    question: "How often does the status page update?",
    answer:
      "The page re-reads public health on the same schedule as the underlying check, so a manual refresh is rarely needed. External integrations should rely on API response headers, Retry-After, and endpoint-specific polling guidance instead of polling this page.",
  },
] as const satisfies readonly FaqItem[];

export default function StatusPage() {
  return <StatusClient faqItems={STATUS_FAQ_ITEMS} />;
}
