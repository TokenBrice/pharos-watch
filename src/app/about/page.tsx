import type { Metadata } from "next";
import {
  ABOUT_METADATA_DESCRIPTION,
  ABOUT_METADATA_TITLE,
  AboutPageContent,
} from "@/components/about/about-page-content";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: ABOUT_METADATA_TITLE,
  titleAbsolute: true,
  description: ABOUT_METADATA_DESCRIPTION,
  canonical: "/about/",
});

export default function AboutPage() {
  return <AboutPageContent />;
}
