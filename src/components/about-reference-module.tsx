import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ABOUT_REFERENCE_ITEMS } from "@/lib/nav-config";

export function AboutReferenceModule() {
  return (
    <section
      aria-label="About reference pages"
      className="rounded-2xl border border-border/60 bg-card/72 px-3 py-3 shadow-[0_16px_36px_oklch(0_0_0_/0.08)] sm:px-4 sm:py-4"
    >
      <h2 className="sr-only">About reference pages</h2>
      <div className="mb-3 flex items-center gap-3">
        <p className="pharos-kicker">Reference Pages</p>
        <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {ABOUT_REFERENCE_ITEMS.map((item) => {
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className="pharos-focus-ring group flex min-h-36 flex-col rounded-[1.2rem] border border-border/60 bg-background/55 px-4 py-4 transition-[border-color,background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-border/85 hover:bg-muted/25 hover:shadow-[0_12px_28px_oklch(0_0_0_/0.12)]"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
              </div>

              <div className="mt-4 space-y-1.5">
                <h3 className="text-base font-semibold tracking-tight text-foreground">{item.label}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{item.description}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
