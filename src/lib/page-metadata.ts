import type { Metadata } from "next";

interface BuildPageMetadataInput {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  ogWidth?: number;
  ogHeight?: number;
  robots?: Metadata["robots"];
}

export function buildPageMetadata({
  title,
  description,
  canonical,
  ogImage,
  ogWidth = 1200,
  ogHeight = 628,
  robots,
}: BuildPageMetadataInput): Metadata {
  const images = [{ url: ogImage, width: ogWidth, height: ogHeight }];

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      images,
    },
    twitter: {
      images,
    },
    robots,
  };
}
