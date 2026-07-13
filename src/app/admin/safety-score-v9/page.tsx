import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import SafetyScoreV9Client from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Safety Score V9 Candidate",
  description: "Access-protected inspection workspace for the Safety Score V9 shadow candidate.",
  canonical: "/admin/safety-score-v9/",
  robots: { index: false, follow: false },
});

export default function SafetyScoreV9Page() {
  return <SafetyScoreV9Client />;
}
