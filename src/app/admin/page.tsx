import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import AdminClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Admin",
  description: "Access-protected operator control panel for Pharos.",
  canonical: "/admin/",
  robots: { index: false, follow: false },
});

export default function AdminPage() {
  return <AdminClient />;
}
