import Link from "next/link";
import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";

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
    <div className="mx-auto w-full max-w-[68rem] space-y-12">
      <BreadcrumbJsonLd items={breadcrumbItems} />
      <header className="space-y-6">
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground sm:text-sm"
        >
          <Link
            href="/"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-3 text-foreground hover:text-foreground sm:min-h-0 sm:rounded-sm sm:border-0 sm:bg-transparent sm:px-0 sm:text-inherit"
          >
            Dashboard
          </Link>
          <span>/</span>
          <Link
            href="/learn/"
            className="pharos-focus-ring inline-flex items-center text-inherit hover:text-foreground"
          >
            Learn
          </Link>
          <span>/</span>
          {finalLabel ? (
            <>
              <Link
                href="/learn/case-studies/"
                className="pharos-focus-ring inline-flex items-center text-inherit hover:text-foreground"
              >
                Case Studies
              </Link>
              <span>/</span>
              <span className="text-foreground">{finalLabel}</span>
            </>
          ) : (
            <span className="text-foreground">Case Studies</span>
          )}
        </nav>
        <h1 className="max-w-[24ch] text-[clamp(2.25rem,4.5vw,4rem)] font-extrabold leading-[0.98] tracking-[-0.035em] text-foreground">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-lg leading-relaxed text-muted-foreground sm:text-xl">
            {subtitle}
          </p>
        ) : null}
        {leadParagraphs.length > 0 ? (
          <div className="space-y-3 text-[15px] leading-relaxed text-muted-foreground">
            {leadParagraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        ) : null}
      </header>
      {children}
    </div>
  );
}
