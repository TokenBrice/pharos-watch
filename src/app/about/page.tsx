import type { Metadata } from "next";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  ABOUT_METADATA_DESCRIPTION,
  ABOUT_METADATA_TITLE,
  AboutPageContent,
} from "@/components/about/about-page-content";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: ABOUT_METADATA_TITLE,
  description: ABOUT_METADATA_DESCRIPTION,
  canonical: "/about/",
  ogImage: `${SITE_ORIGIN}/og-editorial-about.png`,
});

export default function AboutPage() {
  return <AboutPageContent />;
}
