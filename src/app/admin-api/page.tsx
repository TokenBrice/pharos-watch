import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import AdminApiClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "API Management",
  description: "Access-protected API key and self-serve request management for Pharos operators.",
  canonical: "/admin-api/",
  robots: { index: false, follow: false },
});

export default function AdminApiPage() {
  return <AdminApiClient />;
}
