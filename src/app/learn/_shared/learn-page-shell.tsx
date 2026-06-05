import Link from "next/link";
import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { cn } from "@/lib/utils";

interface VisibleBreadcrumbItem {
  label: string;
  href?: string;
}

interface LearnPageShellProps {
  breadcrumbItems: BreadcrumbItem[];
  visibleBreadcrumbs: readonly VisibleBreadcrumbItem[];
  title: string;
  subtitle?: string;
  leadParagraphs?: readonly string[];
  titleClassName?: string;
  wrapBreadcrumbs?: boolean;
  children: React.ReactNode;
}

function breadcrumbLinkClass(href: string): string {
  if (href === "/") {
    return "pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/60 px-3 text-foreground hover:text-foreground sm:min-h-0 sm:rounded-sm sm:border-0 sm:bg-transparent sm:px-0 sm:text-inherit";
  }
  return "pharos-focus-ring inline-flex items-center text-inherit hover:text-foreground";
}

export function LearnPageShell({
  breadcrumbItems,
  visibleBreadcrumbs,
  title,
  subtitle,
  leadParagraphs = [],
  titleClassName = "max-w-[22ch]",
  wrapBreadcrumbs = false,
  children,
}: LearnPageShellProps) {
  return (
    <div className="mx-auto w-full max-w-[68rem] space-y-12">
      <BreadcrumbJsonLd items={breadcrumbItems} />
      <header className="space-y-6">
        <nav
          aria-label="Breadcrumb"
          className={cn(
            "flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm",
            wrapBreadcrumbs && "flex-wrap",
          )}
        >
          {visibleBreadcrumbs.map((item, index) => (
            <span key={`${item.href ?? "current"}-${item.label}-${index}`} className="contents">
              {index > 0 ? <span>/</span> : null}
              {item.href ? (
                <Link href={item.href} className={breadcrumbLinkClass(item.href)}>
                  {item.label}
                </Link>
              ) : (
                <span className="text-foreground">{item.label}</span>
              )}
            </span>
          ))}
        </nav>
        <h1
          className={cn(
            "text-[clamp(2.25rem,4.5vw,4rem)] font-extrabold leading-[0.98] tracking-[-0.035em] text-foreground",
            titleClassName,
          )}
        >
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
