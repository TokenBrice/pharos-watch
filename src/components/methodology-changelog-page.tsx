import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import { MethodologyVersionCard, type MethodologyChangelogEntry } from "@/components/methodology-version-card";

interface MethodologyChangelogPageProps {
  breadcrumbName: string;
  path: string;
  title: string;
  lead: React.ReactNode;
  accentClass?: string;
  entries?: readonly MethodologyChangelogEntry[];
  sections?: readonly { id: string; label: string }[];
  railLabel?: string;
  navAriaLabel?: string;
  children?: React.ReactNode;
}

function changelogEntryId(version: string) {
  return `changelog-v-${version.replaceAll(".", "-")}`;
}

export function MethodologyChangelogPage({
  breadcrumbName,
  path,
  title,
  lead,
  accentClass = "border-l-foreground/50",
  entries = [],
  sections,
  railLabel = "Jump to Version",
  navAriaLabel,
  children,
}: MethodologyChangelogPageProps) {
  const derivedSections = [
    { id: "latest-updates", label: "Latest" },
    ...entries.map((entry) => ({
      id: changelogEntryId(entry.version),
      label: `v${entry.version}`,
    })),
  ];

  const navSections = sections ?? derivedSections;
  const latestEntry = entries[0];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <BreadcrumbJsonLd name={breadcrumbName} path={path} />

      <div className="space-y-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <Link href="/methodology" className="hover:text-foreground transition-colors">
            Methodology
          </Link>
          <span>/</span>
          <span className="text-foreground">{title}</span>
        </nav>

        <h1 className="text-4xl font-extrabold tracking-tighter sm:text-[3.2rem]">{title}</h1>

        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{lead}</p>
      </div>

      <LongformScrollspyNav
        sections={navSections}
        railLabel={railLabel}
        navAriaLabel={navAriaLabel ?? `${title} version navigation`}
      />
      {children ?? (
        <>
          {latestEntry && (
            <section
              id="latest-updates"
              className="scroll-mt-28 rounded-[1.5rem] border border-border/60 border-l-[3px] border-l-foreground/50 bg-card/88 px-5 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.12)] sm:px-6"
            >
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
                <div className="space-y-3">
                  <p className="pharos-kicker">Latest Version</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-block rounded-full border border-border/60 bg-muted/55 px-2.5 py-0.5 text-xs font-medium text-foreground">
                      {`v${latestEntry.version}`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(`${latestEntry.date}T00:00:00Z`).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </span>
                    {latestEntry.reconstructed && (
                      <span className="inline-block rounded-full border border-border/60 bg-background/55 px-2.5 py-0.5 text-xs text-muted-foreground">
                        Reconstructed
                      </span>
                    )}
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight">{latestEntry.title}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{latestEntry.summary}</p>
                </div>
                <div className="rounded-2xl border border-border/50 bg-background/45 px-4 py-4">
                  <p className="pharos-kicker">Impact Snapshot</p>
                  {latestEntry.impact.length > 0 ? (
                    <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                      {latestEntry.impact.slice(0, 4).map((item) => (
                        <li key={item} className="flex items-start gap-2">
                          <span className="mt-[0.42rem] h-1.5 w-1.5 rounded-full bg-foreground/40" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No impact notes recorded for this version.</p>
                  )}
                </div>
              </div>
            </section>
          )}

          <div className="space-y-4">
            {entries.map((entry, index) => (
              <MethodologyVersionCard
                key={entry.version}
                entry={entry}
                accentClass={accentClass}
                entryId={changelogEntryId(entry.version)}
                defaultOpen={index === 0}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
