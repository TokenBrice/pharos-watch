import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import CronsClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Cron Lanes",
  description: "Access-protected scheduled-job health and execution workspace for Pharos operators.",
  canonical: "/admin/crons/",
  robots: { index: false, follow: false },
});

export default function CronsPage() {
  return <CronsClient />;
}
