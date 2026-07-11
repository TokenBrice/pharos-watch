import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import HistoryClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Incident History",
  description: "Access-protected status transitions and release-correlation workspace for Pharos operators.",
  canonical: "/admin/history/",
  robots: { index: false, follow: false },
});

export default function HistoryPage() {
  return <HistoryClient />;
}
