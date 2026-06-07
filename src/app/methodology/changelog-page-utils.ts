import type { Metadata } from "next";
import { INDEXABLE_ROBOTS } from "@/lib/seo-robots";

interface MethodologyChangelogMetadataConfig {
  title: string;
  description: string;
  path: string;
}

export function buildMethodologyChangelogMetadata({
  title,
  description,
  path,
}: MethodologyChangelogMetadataConfig): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: INDEXABLE_ROBOTS,
    openGraph: {
      title,
      description,
      url: path,
      type: "website",
      images: [{ url: "/og-editorial-methodology.png", width: 1200, height: 628 }],
    },
    twitter: {
      images: [{ url: "/og-editorial-methodology.png", width: 1200, height: 628 }],
    },
  };
}
