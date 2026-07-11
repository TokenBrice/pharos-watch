import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/page-metadata";
import PipelineClient from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "Operator Pipeline",
  description: "Access-protected stablecoin pipeline health workspace for Pharos operators.",
  canonical: "/admin/pipeline/",
  robots: { index: false, follow: false },
});

export default function PipelinePage() {
  return <PipelineClient />;
}
