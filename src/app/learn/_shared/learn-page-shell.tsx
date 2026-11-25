import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { cn } from "@/lib/utils";

export interface LearnPageShellProps {
  breadcrumbItems: BreadcrumbItem[];
  /** Optional single parent return link rendered above the eyebrow/H1 on subpages. */
  backLink?: { href: string; label: string };
  /** Optional short uppercase route or article eyebrow (`.pharos-eyebrow`). */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  /** Optional metadata/actions row rendered directly beneath the subtitle and above lead paragraphs. */
  headerMeta?: React.ReactNode;
  leadParagraphs?: readonly string[];
  titleClassName?: string;
  children: React.ReactNode;
}

export function LearnPageShell({
  breadcrumbItems,
  backLink,
  eyebrow,
  title,
  subtitle,
  headerMeta,
  leadParagraphs = [],
  titleClassName = "max-w-[28ch]",
  children,
}: LearnPageShellProps) {
  return (
    <div className="mx-auto w-full max-w-[68rem] space-y-12">
      <BreadcrumbJsonLd items={breadcrumbItems} />
      <header className="space-y-5">
        {backLink ? (
          <Link
            href={backLink.href}
            className="pharos-focus-ring inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-9"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span>{backLink.label}</span>
          </Link>
        ) : null}
        <div className="space-y-3">
          {eyebrow ? <p className="pharos-eyebrow">{eyebrow}</p> : null}
          <h1 className={cn("pharos-page-title text-balance text-foreground", titleClassName)}>
            {title}
          </h1>
          {subtitle ? (
            <p className="pharos-page-lead max-w-3xl">{subtitle}</p>
          ) : null}
        </div>
        {headerMeta}
        {leadParagraphs.length > 0 ? (
          <div className="max-w-[68ch] space-y-3 text-base leading-[1.75] text-foreground/90">
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
