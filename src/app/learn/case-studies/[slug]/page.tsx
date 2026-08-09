import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/lib/page-metadata";
import { CASE_STUDIES, CASE_STUDY_LIST, getCaseStudy } from "../content";
import { CaseStudyArticleJsonLd } from "../case-study-json-ld";
import { CaseStudyBody } from "../case-study-body";
import { LearnPageShell } from "../../_shared/learn-page-shell";

const CASE_STUDY_SLUGS = new Set(CASE_STUDY_LIST.map((study) => study.slug));

export function generateStaticParams() {
  return CASE_STUDY_LIST.map((study) => ({ slug: study.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!CASE_STUDY_SLUGS.has(slug)) {
    return { title: "Not Found", robots: { index: false, follow: false } };
  }
  const study = CASE_STUDIES[slug];
  return buildPageMetadata({
    // Layout applies the "%s | Pharos" title template; keep the bare study title
    // here to avoid double-branding and stay within SERP length.
    title: study.title,
    description: study.metaDescription,
    canonical: `/learn/case-studies/${slug}/`,
    ogImage: `/og-learn-case-${slug}.png`,
  });
}

export default async function CaseStudyPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!CASE_STUDY_SLUGS.has(slug)) {
    notFound();
  }
  const study = getCaseStudy(slug)!;

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Case Studies", url: "/learn/case-studies/" },
        { name: study.title, url: `/learn/case-studies/${slug}/` },
      ]}
      title={study.title}
      subtitle={study.subtitle}
      leadParagraphs={study.lead}
      titleClassName="max-w-[24ch]"
    >
      <CaseStudyArticleJsonLd study={study} />
      <CaseStudyBody study={study} />
    </LearnPageShell>
  );
}
