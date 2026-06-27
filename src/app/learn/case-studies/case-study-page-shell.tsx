import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { LearnPageShell } from "../_shared/learn-page-shell";

interface CaseStudyPageShellProps {
  /** Drives the BreadcrumbList JSON-LD (site-relative urls). */
  breadcrumbItems: BreadcrumbItem[];
  title: string;
  subtitle?: string;
  leadParagraphs?: readonly string[];
  children: React.ReactNode;
}

export function CaseStudyPageShell({
  breadcrumbItems,
  title,
  subtitle,
  leadParagraphs = [],
  children,
}: CaseStudyPageShellProps) {
  return (
    <LearnPageShell
      breadcrumbItems={breadcrumbItems}
      title={title}
      subtitle={subtitle}
      leadParagraphs={leadParagraphs}
      titleClassName="max-w-[24ch]"
    >
      {children}
    </LearnPageShell>
  );
}
