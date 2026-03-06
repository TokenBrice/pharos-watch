import type { Metadata } from "next";
import type { MethodologyChangelogEntry } from "@/components/methodology-version-card";

interface ChangelogSourceEntry {
  version: string;
  title: string;
  date: string;
  summary: string;
  commits: readonly string[];
  reconstructed: boolean;
}

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
    openGraph: {
      title,
      description,
      url: path,
      type: "website",
      images: [{ url: "/og-card.png", width: 1200, height: 628 }],
    },
    twitter: {
      images: [{ url: "/og-card.png", width: 1200, height: 628 }],
    },
  };
}

export function mapMethodologyChangelogEntries<T extends ChangelogSourceEntry>(
  entries: readonly T[],
  selectImpact: (entry: T) => readonly string[],
): MethodologyChangelogEntry[] {
  return entries.map((entry) => ({
    version: entry.version,
    title: entry.title,
    date: entry.date,
    summary: entry.summary,
    impact: selectImpact(entry),
    commits: entry.commits,
    reconstructed: entry.reconstructed,
  }));
}
