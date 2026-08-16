import type { Metadata } from "next";
import Link from "next/link";
import { LearnHero } from "../_shared/learn-hero";
import { LearnPageShell } from "../_shared/learn-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  GLOSSARY_ENTRIES,
  GLOSSARY_LEAD,
  groupGlossaryByLetter,
  type GlossaryEntry,
} from "@/lib/glossary-content";

// Full A-Z jump rail; letters without entries render as disabled placeholders.
const JUMP_RAIL_ALPHABET = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
);

const GLOSSARY_METADATA_DESCRIPTION =
  "Stablecoin risk glossary for Pharos terms including PSI, DEWS, PegScore, LiquidityScore, FreezeWatch, Bluechip, PressureShift, bands, gates, and methodology anchors.";
const GLOSSARY_PAGE_URL = `${SITE_ORIGIN}/learn/glossary/`;
const GLOSSARY_DEFINED_TERM_SET_ID = `${GLOSSARY_PAGE_URL}#defined-term-set`;
const GLOSSARY_DEFINED_TERM_SET_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "DefinedTermSet",
  "@id": GLOSSARY_DEFINED_TERM_SET_ID,
  name: "Pharos Glossary",
  description: GLOSSARY_METADATA_DESCRIPTION,
  url: GLOSSARY_PAGE_URL,
  inLanguage: "en",
  publisher: { "@id": `${SITE_ORIGIN}#organization` },
  hasDefinedTerm: GLOSSARY_ENTRIES.map((entry) => ({
    "@type": "DefinedTerm",
    "@id": `${GLOSSARY_PAGE_URL}#${entry.id}`,
    name: entry.term,
    termCode: entry.id,
    description: entry.definition,
    url: `${GLOSSARY_PAGE_URL}#${entry.id}`,
    inDefinedTermSet: { "@id": GLOSSARY_DEFINED_TERM_SET_ID },
    subjectOf: {
      "@type": "WebPage",
      name: `${entry.term} methodology reference`,
      url: `${SITE_ORIGIN}${entry.methodologyAnchor}`,
    },
  })),
} as const;

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Risk Glossary: PSI, DEWS, PegScore & More",
  description: GLOSSARY_METADATA_DESCRIPTION,
  canonical: "/learn/glossary/",
  ogImage: `${SITE_ORIGIN}/og-editorial-learn.png`,
});

const ENTRIES_BY_ID = new Map<string, GlossaryEntry>(
  GLOSSARY_ENTRIES.map((entry) => [entry.id, entry]),
);

function GlossaryJumpRail({
  presentLetters,
}: {
  presentLetters: ReadonlySet<string>;
}) {
  return (
    <nav
      aria-label="Glossary jump rail"
      className="sticky top-16 z-10 -mx-1 rounded-xl border border-border/60 bg-background/80 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60"
    >
      <ol className="flex flex-wrap gap-1 font-mono text-xs uppercase tracking-[0.06em]">
        {JUMP_RAIL_ALPHABET.map((letter) => {
          const isPresent = presentLetters.has(letter);
          return (
            <li key={letter}>
              {isPresent ? (
                <a
                  href={`#letter-${letter}`}
                  className="pharos-focus-ring inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-border/60 bg-background/60 px-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  {letter}
                </a>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-full border border-border/30 bg-background/30 px-1.5 text-muted-foreground/70"
                >
                  {letter}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function GlossaryEntryBlock({ entry }: { entry: GlossaryEntry }) {
  const seeAlsoEntries = (entry.seeAlso ?? [])
    .map((id) => ENTRIES_BY_ID.get(id))
    .filter((value): value is GlossaryEntry => Boolean(value));

  return (
    <article id={entry.id} className="scroll-mt-32 space-y-3 py-7 first:pt-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          className="text-xl font-semibold leading-tight tracking-tight text-foreground sm:text-2xl"
        >
          {entry.term}
        </h2>
        <p className="pharos-kicker">Methodology {entry.methodologyVersion}</p>
      </header>
      <p
        className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]"
      >
        {entry.definition}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        <Link
          href={entry.methodologyAnchor}
          className="pharos-focus-ring rounded-sm text-foreground hover:underline hover:underline-offset-4"
        >
          Methodology &rarr;
        </Link>
        {entry.example ? (
          <Link
            href={entry.example.href}
            className="pharos-focus-ring rounded-sm text-foreground hover:underline hover:underline-offset-4"
          >
            {entry.example.label}
          </Link>
        ) : null}
        {seeAlsoEntries.length > 0 ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span aria-hidden="true" className="text-muted-foreground/70">
              See also
            </span>
            {seeAlsoEntries.map((related, index) => (
              <span key={related.id} className="flex items-center gap-x-3">
                <a
                  href={`#${related.id}`}
                  className="pharos-focus-ring rounded-sm text-foreground hover:underline hover:underline-offset-4"
                >
                  {related.term}
                </a>
                {index < seeAlsoEntries.length - 1 ? (
                  <span aria-hidden="true" className="text-muted-foreground/50">
                    ·
                  </span>
                ) : null}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </article>
  );
}

export default function GlossaryPage() {
  const groups = groupGlossaryByLetter(GLOSSARY_ENTRIES);
  const presentLetters = new Set(groups.map((group) => group.letter));

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Glossary", url: "/learn/glossary/" },
      ]}
      title="Pharos Glossary"
      subtitle={GLOSSARY_LEAD}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd(GLOSSARY_DEFINED_TERM_SET_JSON_LD),
        }}
      />
      <div className="space-y-8">
        <LearnHero
          beamLabel="Terms defined"
          beamValue={GLOSSARY_ENTRIES.length}
          subKicker="Version-pinned"
          sub={
            <div className="space-y-1 font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
              <p>Anchored to methodology</p>
              <p>A&ndash;Z</p>
            </div>
          }
          ariaLabel="Glossary coverage"
        />
        <GlossaryJumpRail presentLetters={presentLetters} />
        <div className="divide-y divide-border/60 border-y border-border/60">
          {groups.map((group) => (
            <section
              key={group.letter}
              aria-labelledby={`letter-${group.letter}`}
              className="space-y-1"
            >
              <header
                id={`letter-${group.letter}`}
                className="scroll-mt-32 pt-7"
              >
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {group.letter}
                </p>
              </header>
              <div className="divide-y divide-border/40">
                {group.entries.map((entry) => (
                  <GlossaryEntryBlock key={entry.id} entry={entry} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="border-t border-border/60 pt-5 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">
              A note on version pins
            </span>{" "}
            — every entry pins the methodology version of the section it cites.
            When a methodology version moves, the corresponding entry is
            re-read; entries whose definition the new version changes are
            re-authored before the pin is bumped.
          </p>
        </aside>
      </div>
    </LearnPageShell>
  );
}
