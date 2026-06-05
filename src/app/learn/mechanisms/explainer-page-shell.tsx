import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { LearnPageShell } from "../_shared/learn-page-shell";

interface ExplainerPageShellProps {
  breadcrumbItems: BreadcrumbItem[];
  breadcrumbLabel: string;
  title: string;
  subtitle?: string;
  leadParagraphs?: readonly string[];
  children: React.ReactNode;
}

export function ExplainerPageShell({
  breadcrumbItems,
  breadcrumbLabel,
  title,
  subtitle,
  leadParagraphs = [],
  children,
}: ExplainerPageShellProps) {
  return (
    <LearnPageShell
      breadcrumbItems={breadcrumbItems}
      visibleBreadcrumbs={[
        { label: "Dashboard", href: "/" },
        { label: "Learn", href: "/learn/" },
        { label: breadcrumbLabel },
      ]}
      title={title}
      subtitle={subtitle}
      leadParagraphs={leadParagraphs}
      titleClassName="max-w-[22ch]"
    >
      {children}
    </LearnPageShell>
  );
}
