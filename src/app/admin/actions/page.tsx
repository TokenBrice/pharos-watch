import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import ActionsClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Actions",
  description: "Access-protected recovery, audit, and backfill action workspace for Pharos operators.",
  canonical: "/admin/actions/",
  robots: { index: false, follow: false },
});

export default function ActionsPage() {
  return <ActionsClient />;
}
