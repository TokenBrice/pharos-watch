import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import StatusClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "System Status",
  description: "Public Pharos system health, cache freshness, and endpoint availability.",
  canonical: "/status/",
});

export default function StatusPage() {
  return <StatusClient />;
}
