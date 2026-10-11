import Link from "next/link";
import { JsonLdScript } from "@/components/json-ld-script";
import {
  DEFINITIONS_SECTION_ID,
  getListedDefinitions,
  type DefinitionKey,
  type ListedDefinition,
} from "@/lib/definitions";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { METHODOLOGY_LINK_CLASS, MethodologySectionShell } from "../methodology-shared";

const PAGE_URL = `${SITE_ORIGIN}/methodology/`;
const TERM_SET_ID = `${PAGE_URL}#${DEFINITIONS_SECTION_ID}`;

function letterOf(term: string): string {
  return term.charAt(0).toUpperCase();
}

function buildDefinedTermSetJsonLd(definitions: readonly ListedDefinition[]) {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": TERM_SET_ID,
    name: "Pharos Definitions",
    description: "Stablecoin risk terms used by Pharos, from PSI and DEWS to CDPs and attestations.",
    url: TERM_SET_ID,
    inLanguage: "en",
    publisher: { "@id": `${SITE_ORIGIN}#organization` },
    hasDefinedTerm: definitions.map((def) => ({
      "@type": "DefinedTerm",
      "@id": `${PAGE_URL}#${def.anchorId}`,
      name: def.term,
      termCode: def.key,
      description: def.text,
      url: `${PAGE_URL}#${def.anchorId}`,
      inDefinedTermSet: { "@id": TERM_SET_ID },
    })),
  };
}

export function DefinitionsSection() {
  const definitions = getListedDefinitions();
  const byKey = new Map<DefinitionKey, ListedDefinition>(definitions.map((def) => [def.key, def]));
  const groups = new Map<string, ListedDefinition[]>();
  for (const def of definitions) {
    const letter = letterOf(def.term);
    groups.set(letter, [...(groups.get(letter) ?? []), def]);
  }

  return (
    <MethodologySectionShell id={DEFINITIONS_SECTION_ID} title="Definitions">
      <JsonLdScript json={safeJsonLd(buildDefinedTermSetJsonLd(definitions))} />
      <p>
        The terms used across Pharos, A–Z. The same text powers the tooltips on the site; methodology links point to
        the section above that owns each metric.
      </p>
      <nav aria-label="Definitions by letter">
        <ul className="flex flex-wrap gap-1.5">
          {[...groups.keys()].map((letter) => (
            <li key={letter}>
              <a
                href={`#${DEFINITIONS_SECTION_ID}-${letter.toLowerCase()}`}
                className="pharos-focus-ring inline-flex h-8 min-w-8 items-center justify-center rounded-full border border-border/60 px-2 font-mono text-xs text-foreground hover:bg-muted/50"
              >
                {letter}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="lg:columns-2 lg:gap-10">
        {[...groups.entries()].map(([letter, entries]) => (
          <section key={letter} className="pb-4" aria-labelledby={`${DEFINITIONS_SECTION_ID}-${letter.toLowerCase()}`}>
            <h3
              id={`${DEFINITIONS_SECTION_ID}-${letter.toLowerCase()}`}
              className="scroll-mt-36 break-after-avoid border-b border-border/50 pb-1 font-mono text-xs font-semibold text-foreground md:scroll-mt-28"
            >
              {letter}
            </h3>
            <dl>
              {entries.map((def) => (
                <div key={def.key} id={def.anchorId} className="scroll-mt-36 break-inside-avoid space-y-1.5 border-b border-border/40 py-3 last:border-b-0 md:scroll-mt-28">
                  <dt className="font-semibold text-foreground">{def.term}</dt>
                  <dd className="space-y-1.5">
                    <p>{def.text}</p>
                    {def.methodologyPath || def.seeAlso.length > 0 ? (
                      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        {def.methodologyPath ? (
                          <Link href={def.methodologyPath} className={METHODOLOGY_LINK_CLASS}>
                            Methodology{def.versionLabel ? ` ${def.versionLabel}` : ""}
                          </Link>
                        ) : null}
                        {def.seeAlso.length > 0 ? (
                          <span>
                            See also:{" "}
                            {def.seeAlso.map((key, index) => {
                              const related = byKey.get(key)!;
                              return (
                                <span key={key}>
                                  {index > 0 ? ", " : null}
                                  <a href={`#${related.anchorId}`} className={METHODOLOGY_LINK_CLASS}>
                                    {related.term}
                                  </a>
                                </span>
                              );
                            })}
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </MethodologySectionShell>
  );
}
