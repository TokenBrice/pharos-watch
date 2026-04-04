import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ABOUT_REFERENCE_ITEMS } from "@/lib/nav-config";
import { cn } from "@/lib/utils";

/** Per-card accent drawn from the tone palette used across the about page. */
const CARD_ACCENTS = [
  { icon: "text-amber-600 dark:text-amber-400", hover: "hover:border-amber-500/40" },
  { icon: "text-emerald-600 dark:text-emerald-400", hover: "hover:border-emerald-500/40" },
  { icon: "text-sky-600 dark:text-frost-blue", hover: "hover:border-frost-blue/40" },
  { icon: "text-violet-600 dark:text-violet-400", hover: "hover:border-violet-500/40" },
] as const;

export function AboutReferenceModule() {
  return (
    <section
      aria-label="Reference pages"
      className="rounded-2xl border border-border/60 bg-card/72 px-3 py-4 shadow-[0_16px_36px_oklch(0_0_0_/0.08)] sm:px-5 sm:py-5"
    >
      <h2 className="sr-only">Reference pages</h2>
      <div className="mb-4 flex items-center gap-3">
        <p className="pharos-kicker">Reference Pages</p>
        <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {ABOUT_REFERENCE_ITEMS.map((item, i) => {
          const Icon = item.icon;
          const accent = CARD_ACCENTS[i % CARD_ACCENTS.length];

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "pharos-focus-ring group flex min-h-[9.5rem] flex-col rounded-xl border border-border/60 bg-background/55 px-5 py-5",
                "transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                "hover:-translate-y-1.5 hover:bg-muted/20 hover:shadow-[0_20px_44px_oklch(0_0_0_/0.18)]",
                accent.hover,
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <Icon className={cn("h-[1.2rem] w-[1.2rem]", accent.icon)} aria-hidden="true" />
                <ArrowRight
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </div>

              <div className="mt-auto space-y-1.5 pt-4">
                <h3 className="text-[1.05rem] font-bold leading-tight tracking-tight text-foreground">{item.label}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{item.description}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
