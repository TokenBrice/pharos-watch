import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CrossLink {
  href: string;
  label: ReactNode;
}

export function SectionKicker({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cn("pharos-kicker", className)}>{children}</p>;
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.75rem]">
      {children}
    </h2>
  );
}

export function NumberedListSection({
  items,
  kicker,
  heading,
  kickerClass,
}: {
  items: readonly ReactNode[];
  kicker: ReactNode;
  heading: ReactNode;
  kickerClass: string;
}) {
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <SectionKicker className={kickerClass}>{kicker}</SectionKicker>
        <SectionHeading>{heading}</SectionHeading>
      </div>
      <ol className="divide-y divide-border/40">
        {items.map((item, i) => (
          <li
            key={i}
            className="grid gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[3rem_minmax(0,1fr)] sm:gap-6"
          >
            <span className="font-mono text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <p className="text-[15px] leading-relaxed text-foreground">
              {item}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function CrossLinksFooter({
  links,
  kickerClass,
  kicker = "Continue reading",
}: {
  links: readonly CrossLink[];
  kickerClass: string;
  kicker?: ReactNode;
}) {
  return (
    <section className="space-y-5 border-t border-border/60 pt-10">
      <SectionKicker className={kickerClass}>{kicker}</SectionKicker>
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link, i) => (
          <li key={i}>
            <Link
              href={link.href}
              className="pharos-focus-ring group flex items-start justify-between gap-3 border-b border-border/40 py-3 text-[15px] leading-snug text-foreground transition-colors hover:border-frost-blue/60 hover:text-frost-blue"
            >
              <span>{link.label}</span>
              <ArrowUpRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
