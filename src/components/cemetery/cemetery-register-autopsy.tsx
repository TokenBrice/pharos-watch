import Link from "next/link";
import { useState } from "react";
import { CAUSE_META } from "@shared/lib/cause-of-death";
import { parseCemeteryDeathDate } from "@shared/lib/cemetery";
import { getMechanismArchetypeCtaNoun, getMechanismExplainerPath } from "@shared/lib/classification";
import { formatAddress } from "@shared/lib/format";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { causeColorVars } from "@/lib/cemetery-cause-style";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { cemeteryCauseAnchor } from "@/lib/cemetery-selection";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";
import { digestDisplay } from "@/lib/fonts/digest";
import { formatRegisterDeathDate } from "./cemetery-register-model";
import styles from "./cemetery-register.module.css";

const CONTRACT_PREVIEW_COUNT = 4;
const ACTION_CLASS = `pharos-prose-link ${styles.action}`;

export interface CemeteryRegisterAutopsyProps {
  row: CemeteryRegisterRow;
  /**
   * A collapsed autopsy still renders the obituary and source link (crawlable,
   * and shown by a `#<id>` fragment without JS; the main row above it carries
   * the facts). The fact list, contracts and the remaining actions render once
   * expanded.
   */
  expanded: boolean;
  onShowOnField: (id: string) => void;
}

/**
 * One record's autopsy. The epitaph is set as a Newsreader italic pull line:
 * the sanctioned cemetery serif carve-out (design-invariants allowlist).
 */
export function CemeteryRegisterAutopsy({ row, expanded, onShowOnField }: CemeteryRegisterAutopsyProps) {
  const { copied, copy } = useCopyToClipboard();
  const [allContracts, setAllContracts] = useState(false);
  const contracts = allContracts ? row.contracts : row.contracts.slice(0, CONTRACT_PREVIEW_COUNT);
  const mechanismNoun = row.mechanismArchetype ? getMechanismArchetypeCtaNoun(row.mechanismArchetype) : null;
  const causeLabel = CAUSE_META[row.cause].label;

  return (
    <div className={styles.autopsy}>
      <div className="min-w-0 space-y-3">
        <p className="pharos-kicker">{`Autopsy · ${row.name} (${row.symbol})`}</p>
        {row.epitaph ? <p className={`${digestDisplay.className} ${styles.epitaph}`}>{row.epitaph}</p> : null}
        <p className={styles.obituary}>{row.obituary}</p>
        <ul className={styles.actions}>
          <li>
            <a href={row.sourceUrl} target="_blank" rel="noopener noreferrer" className={ACTION_CLASS}>
              {`Source: ${row.sourceLabel}`}
              <span aria-hidden="true">&nbsp;↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
          {expanded && row.tracked ? (
            <li>
              <Link href={buildStablecoinUrl(row.id)} className={ACTION_CLASS}>
                Archived data<span aria-hidden="true">&nbsp;→</span>
              </Link>
            </li>
          ) : null}
          {expanded && row.caseStudy ? (
            <li>
              <Link href={`/learn/case-studies/${row.caseStudy.slug}/`} className={ACTION_CLASS}>
                Case study: {row.caseStudy.title}
                <span aria-hidden="true">&nbsp;→</span>
              </Link>
            </li>
          ) : null}
          {expanded ? (
            <li>
              <button
                type="button"
                className={ACTION_CLASS}
                onClick={() => void copy(`${SITE_ORIGIN}/cemetery/#${encodeURIComponent(row.id)}`)}
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
              <span role="status" className="sr-only">
                {copied ? "Link copied." : ""}
              </span>
            </li>
          ) : null}
          {expanded ? (
            <li>
              <button type="button" className={ACTION_CLASS} onClick={() => onShowOnField(row.id)}>
                Show on the field<span aria-hidden="true">&nbsp;↑</span>
              </button>
            </li>
          ) : null}
        </ul>
      </div>

      {expanded ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] content-start gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Cause</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span aria-hidden="true" className={styles.dot} style={causeColorVars(row.cause)} />
            <span>{causeLabel}</span>
            <a
              href={`#${cemeteryCauseAnchor(row.cause)}`}
              className="pharos-prose-link text-muted-foreground"
              aria-label={`Definition of ${causeLabel}`}
            >
              definition
            </a>
          </dd>

          <dt className="text-muted-foreground">Died</dt>
          <dd>
            <span className="pharos-numeric">{formatRegisterDeathDate(row.deathDate)}</span>{" "}
            <span className="text-muted-foreground">
              ({parseCemeteryDeathDate(row.deathDate)?.day == null ? "month" : "day"} precision)
            </span>
          </dd>

          <dt className="text-muted-foreground">Peak market cap</dt>
          <dd>
            {row.peak === null ? (
              <span className="text-muted-foreground">Not recorded</span>
            ) : (
              <span className="pharos-numeric">{formatCemeteryPeak(row.peak)}</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Peg</dt>
          <dd className="pharos-numeric">{row.pegCurrency}</dd>

          <dt className="text-muted-foreground">Record</dt>
          <dd>{row.tracked ? "Tracked archive: frozen detail page" : "Curated record"}</dd>

          <dt className="text-muted-foreground">Mechanism</dt>
          <dd>
            {row.mechanismArchetype && mechanismNoun ? (
              <Link href={getMechanismExplainerPath(row.mechanismArchetype)} className="pharos-prose-link">
                {mechanismNoun.charAt(0).toUpperCase()}
                {mechanismNoun.slice(1)} explainer<span aria-hidden="true">&nbsp;→</span>
              </Link>
            ) : (
              <span className="text-muted-foreground">Not recorded</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Contracts</dt>
          <dd className="min-w-0">
            {row.contracts.length === 0 ? (
              <span className="text-muted-foreground">Not recorded</span>
            ) : (
              <>
                <ul className="space-y-1">
                  {contracts.map((contract) => (
                    <li key={`${contract.chainName}:${contract.address}`} className="font-mono text-xs">
                      {contract.explorerUrl ? (
                        <a
                          href={contract.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={contract.address}
                          className="pharos-prose-link inline-flex min-h-11 items-center gap-1.5 md:min-h-0"
                        >
                          <span className="text-muted-foreground">{contract.chainName}</span>
                          {formatAddress(contract.address)}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        <span title={contract.address} className="inline-flex gap-1.5">
                          <span className="text-muted-foreground">{contract.chainName}</span>
                          {formatAddress(contract.address)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {row.contracts.length > CONTRACT_PREVIEW_COUNT ? (
                  <button
                    type="button"
                    aria-expanded={allContracts}
                    onClick={() => setAllContracts((open) => !open)}
                    className={`${ACTION_CLASS} mt-1 text-xs text-muted-foreground`}
                  >
                    {allContracts ? "Show fewer contracts" : `Show all ${row.contracts.length} contracts`}
                  </button>
                ) : null}
              </>
            )}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}
