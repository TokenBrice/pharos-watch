import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import ReliabilityClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Reliability",
  description: "Access-protected endpoint, cache, circuit, and demand reliability workspace for Pharos operators.",
  canonical: "/admin/reliability/",
  robots: { index: false, follow: false },
});

export default function ReliabilityPage() {
  return <ReliabilityClient />;
}
