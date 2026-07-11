import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import CommsClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Comms",
  description: "Access-protected Telegram delivery and operator messaging workspace for Pharos operators.",
  canonical: "/admin/comms/",
  robots: { index: false, follow: false },
});

export default function CommsPage() {
  return <CommsClient />;
}
