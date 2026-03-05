import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";
import {
  MethodologyVersionCard,
  type MethodologyChangelogEntry,
} from "@/components/methodology-version-card";

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
    <div className="space-y-8">
      <BreadcrumbJsonLd name={breadcrumbName} path={path} />

      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
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

        <h1 className="text-4xl font-extrabold tracking-tighter">{title}</h1>

        <p className="text-sm text-muted-foreground">{lead}</p>
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
              className="scroll-mt-28 rounded-xl border border-border/60 border-l-[3px] border-l-foreground/50 bg-card px-6 py-5"
            >
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Latest Changes
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
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
                </div>
                <h2 className="text-lg font-semibold tracking-tight">{latestEntry.title}</h2>
                <p className="text-sm text-muted-foreground">{latestEntry.summary}</p>
                {latestEntry.impact.length > 0 && (
                  <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                    {latestEntry.impact.slice(0, 3).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
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
