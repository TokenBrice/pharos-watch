import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { LearnPageShell } from "../_shared/learn-page-shell";

interface VisibleCaseStudyBreadcrumbItem {
  label: string;
  href?: string;
}

export function buildCaseStudyVisibleBreadcrumbs(finalLabel?: string): readonly VisibleCaseStudyBreadcrumbItem[] {
  return [
    { label: "Dashboard", href: "/" },
    { label: "Learn", href: "/learn/" },
    ...(finalLabel
      ? [{ label: "Case Studies", href: "/learn/case-studies/" }, { label: finalLabel }]
      : [{ label: "Case Studies" }]),
  ];
}

interface CaseStudyPageShellProps {
  /** Drives the BreadcrumbList JSON-LD (site-relative urls). */
  breadcrumbItems: BreadcrumbItem[];
  title: string;
  subtitle?: string;
  leadParagraphs?: readonly string[];
  /** Trailing visible crumb (a study title). Omit on the hub. */
  finalLabel?: string;
  children: React.ReactNode;
}

export function CaseStudyPageShell({
  breadcrumbItems,
  title,
  subtitle,
  leadParagraphs = [],
  finalLabel,
  children,
}: CaseStudyPageShellProps) {
  return (
    <LearnPageShell
      breadcrumbItems={breadcrumbItems}
      visibleBreadcrumbs={buildCaseStudyVisibleBreadcrumbs(finalLabel)}
      title={title}
      subtitle={subtitle}
      leadParagraphs={leadParagraphs}
      titleClassName="max-w-[24ch]"
      wrapBreadcrumbs
    >
      {children}
    </LearnPageShell>
  );
}
