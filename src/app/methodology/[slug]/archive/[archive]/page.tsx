import { notFound } from "next/navigation";
import Link from "next/link";
import { MethodologyChangelogPage } from "@/components/methodology-history/methodology-changelog-page";
import { scoringAnchorId } from "@/components/methodology-history/methodology-changelog-detail";
import { buildPageMetadata } from "@/lib/page-metadata";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { METHODOLOGY_HISTORY_ARCHIVES } from "@shared/lib/methodology-versions/archives";
import { ScoringChangelogContent } from "../../../changelog-content/scoring/content";
import { CHANGELOG_ROUTE_META, getSiblingArchives } from "../../changelog-meta";

interface ArchivePageProps {
  params: Promise<{ slug: string; archive: string }>;
}

export const dynamicParams = false;

export function generateStaticParams() {
  return METHODOLOGY_HISTORY_ARCHIVES.map(({ slug, archive }) => ({ slug, archive }));
}

export async function generateMetadata({ params }: ArchivePageProps) {
  const { slug, archive } = await params;
  const history = METHODOLOGY_HISTORY_ARCHIVES.find((entry) => entry.slug === slug && entry.archive === archive);
  if (!history) return { title: "Archive Not Found" };
  return buildPageMetadata({
    title: `${history.changelog.markdownTitle}: ${archive} Archive`,
    description: `Full ${archive} release bodies and provenance for ${history.changelog.feedLabel}. Historical rules, not necessarily the current methodology.`,
    canonical: history.path,
  });
}

export default async function MethodologyArchivePage({ params }: ArchivePageProps) {
  const { slug, archive } = await params;
  const history = METHODOLOGY_HISTORY_ARCHIVES.find((entry) => entry.slug === slug && entry.archive === archive);
  if (!history) notFound();

  const routeMeta = CHANGELOG_ROUTE_META[history.changelog.key];
  const safetySections =
    history.changelog.key === "safety-score"
      ? [
          { id: "overview", label: "Overview" },
          ...history.entries.map((entry) => {
            const label = toMethodologyVersionLabel(entry.version);
            return { id: scoringAnchorId(label), label };
          }),
        ]
      : undefined;

  return (
    <MethodologyChangelogPage
      breadcrumbName={`${history.changelog.feedLabel} ${archive} archive`}
      path={history.path}
      title={`${history.changelog.markdownTitle}: ${archive} archive`}
      lead={
        <>
          Historical release evidence.{" "}
          <Link href={history.changelog.publicPath} className="pharos-prose-link text-foreground">
            Return to current versions and the complete history index.
          </Link>
        </>
      }
      entries={history.entries}
      archiveShard
      backLink={{ href: history.changelog.publicPath, label: "Latest changelog" }}
      methodologyAnchor={routeMeta.methodologyAnchor}
      docsPath={routeMeta.docsPath}
      siblingArchives={getSiblingArchives(slug, archive)}
      sections={safetySections}
    >
      {history.changelog.key === "safety-score" ? <ScoringChangelogContent entries={history.entries} /> : undefined}
    </MethodologyChangelogPage>
  );
}
