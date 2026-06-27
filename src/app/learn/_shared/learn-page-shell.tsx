import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { cn } from "@/lib/utils";

interface LearnPageShellProps {
  breadcrumbItems: BreadcrumbItem[];
  title: string;
  subtitle?: string;
  leadParagraphs?: readonly string[];
  titleClassName?: string;
  children: React.ReactNode;
}

export function LearnPageShell({
  breadcrumbItems,
  title,
  subtitle,
  leadParagraphs = [],
  titleClassName = "max-w-[22ch]",
  children,
}: LearnPageShellProps) {
  return (
    <div className="mx-auto w-full max-w-[68rem] space-y-12">
      <BreadcrumbJsonLd items={breadcrumbItems} />
      <header className="space-y-6">
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
