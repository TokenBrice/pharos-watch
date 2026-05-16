import Link from "next/link";
import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";

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
    <div className="mx-auto w-full max-w-[68rem] space-y-12">
      <BreadcrumbJsonLd items={breadcrumbItems} />
      <header className="space-y-6">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm"
        >
          <Link
            href="/"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-3 text-foreground hover:text-foreground sm:min-h-0 sm:rounded-sm sm:border-0 sm:bg-transparent sm:px-0 sm:text-inherit"
          >
            Dashboard
          </Link>
          <span>/</span>
          <Link
            href="/learn/mechanisms/"
            className="pharos-focus-ring inline-flex items-center text-inherit hover:text-foreground"
          >
            Learn
          </Link>
          <span>/</span>
          <span className="text-foreground">{breadcrumbLabel}</span>
        </nav>
        <h1 className="max-w-[22ch] text-[clamp(2.25rem,4.5vw,4rem)] font-extrabold leading-[0.98] tracking-[-0.035em] text-foreground">
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
