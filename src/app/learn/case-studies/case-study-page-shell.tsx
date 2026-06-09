import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { LearnPageShell } from "../_shared/learn-page-shell";

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
      visibleBreadcrumbs={[
        { label: "Dashboard", href: "/" },
        { label: "Learn" },
        ...(finalLabel
          ? [
              { label: "Case Studies", href: "/learn/case-studies/" },
              { label: finalLabel },
            ]
          : [{ label: "Case Studies" }]),
      ]}
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
