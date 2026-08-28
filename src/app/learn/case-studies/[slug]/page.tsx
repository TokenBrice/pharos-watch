import { buildPageMetadata } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { CASE_STUDY_LIST, type CaseStudy } from "@/lib/case-studies";
import { CaseStudyArticleJsonLd } from "../case-study-json-ld";
import { CaseStudyBody } from "../case-study-body";
import { LearnPageShell } from "../../_shared/learn-page-shell";

const CASE_STUDY_BY_SLUG = new Map<string, CaseStudy>(CASE_STUDY_LIST.map((study) => [study.slug, study]));

function renderCaseStudy(study: CaseStudy, slug: string) {
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

const route = createStaticSlugRoute({
  paramKey: "slug",
  pages: CASE_STUDY_LIST,
  pageBySlug: CASE_STUDY_BY_SLUG,
  metadata: (study, slug) => buildPageMetadata({
    // Layout applies the "%s | Pharos" title template; keep the bare study title
    // here to avoid double-branding and stay within SERP length.
    title: study.title,
    description: study.metaDescription,
    canonical: `/learn/case-studies/${slug}/`,
    ogImage: `/og-learn-case-${slug}.png`,
  }),
  missingMetadata: { title: "Not Found", robots: { index: false, follow: false } },
  render: renderCaseStudy,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
