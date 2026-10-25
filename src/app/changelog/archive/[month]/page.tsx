import Link from "next/link";
import { notFound } from "next/navigation";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ChangelogTimeline } from "@/components/changelog-timeline";
import { CHANGELOG_MONTH_ARCHIVES } from "@/lib/changelog-history";
import { buildPageMetadata } from "@/lib/page-metadata";

interface ArchivePageProps { params: Promise<{ month: string }> }

export const dynamicParams = false;
export function generateStaticParams() {
  return CHANGELOG_MONTH_ARCHIVES.map(({ month }) => ({ month }));
}

export async function generateMetadata({ params }: ArchivePageProps) {
  const { month } = await params;
  const archive = CHANGELOG_MONTH_ARCHIVES.find((entry) => entry.month === month);
  if (!archive) return { title: "Archive Not Found" };
  return buildPageMetadata({
    title: `Changelog: ${archive.label} Release Notes`,
    description: `Complete weekly Pharos release notes for ${archive.label}: stablecoin coverage additions, data pipeline improvements and product changes.`,
    canonical: archive.path,
    ogImage: "/og-changelog.png",
  });
}

export default async function ChangelogArchivePage({ params }: ArchivePageProps) {
  const { month } = await params;
  const archive = CHANGELOG_MONTH_ARCHIVES.find((entry) => entry.month === month);
  if (!archive) notFound();
  return (
    <FeaturePageShell breadcrumbName={`${archive.label} changelog`} path={archive.path} title={`Changelog: ${archive.label}`} variant="longform">
      <Link href="/changelog/" className="pharos-prose-link">Latest releases and all monthly archives</Link>
      <ChangelogTimeline entries={archive.entries} highlightLatest={false} />
    </FeaturePageShell>
  );
}
