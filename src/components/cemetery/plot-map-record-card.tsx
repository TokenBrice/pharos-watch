/**
 * Stablecoin Cemetery plot map: one grave's record card, shared by the desktop inspector and the phone sheet.
 * Presentational (no state, no directive; it lives inside the client hero tree). Newsreader carries the name, the
 * editorial title and the epitaph (the sanctioned cemetery carve-out); figures are mono.
 *
 * Pinned: kicker "Pinned · May 2022", the FULL obituary (scrollable), the Died / Peak / Peg / Record grid, the record's
 * links and "Leave a flower" (the count stays hidden until the first flower). Preview (desktop hover/focus only):
 * cause kicker, obituary lead and a pin hint, no actions.
 */
import Link from "next/link";
import type { ReactElement } from "react";
import { getMechanismExplainerPath } from "@shared/lib/classification";
import { formatDeathDate } from "@shared/lib/format";
import { getObituaryLead } from "@/lib/cemetery-editorial";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { digestDisplay } from "@/lib/fonts/digest";
import { plotCauseClass } from "./plot-map-shapes";
import styles from "./plot-map.module.css";

export interface PlotMapRecordCardProps {
  row: CemeteryRegisterRow;
  /** Hand-curated display title (`EDITORIAL_TITLES`), when the record has one. */
  editorialTitle?: string;
  /** Flowers left at this grave this session. */
  flowers: number;
  onLeaveFlower: () => void;
  onReadRegister: () => void;
  onClose: () => void;
  variant: "inspector" | "sheet";
  /** Hover/focus preview on the desktop: obituary lead, no actions. */
  preview?: boolean;
}

export function PlotMapRecordCard({ row, editorialTitle, flowers, onLeaveFlower, onReadRegister, onClose, variant, preview = false }: PlotMapRecordCardProps): ReactElement {
  const titleId = `plot-card-title-${variant}`;
  const serif = digestDisplay.className;
  const flowerLine = flowers > 0 ? `${flowers} ${flowers === 1 ? "flower" : "flowers"} left this session` : null;
  return (
    <article className={`${styles.card} ${plotCauseClass(row.cause)}`} aria-labelledby={titleId} data-plot-card={variant} data-preview={preview || undefined}>
      <p className={styles.cardKicker}>
        <span>{preview ? `${row.causeLabel} · ${row.deathDateLabel}` : `Pinned · ${formatDeathDate(row.deathDate.slice(0, 7))}`}</span>
        {preview ? null : (
          <button type="button" className={styles.cardClose} aria-label={`Unpin ${row.name}`} onClick={onClose} data-plot-card-close>
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </p>
      <h2 id={titleId} className={`${styles.cardName} ${serif}`}>
        {row.name}
        <span className={styles.cardSymbol}>{row.symbol}</span>
      </h2>
      {editorialTitle ? <p className={`${styles.cardTitle} ${serif}`}>{editorialTitle}</p> : null}
      {row.epitaph ? <p className={`${styles.cardEpitaph} ${serif}`}>“{row.epitaph}”</p> : null}
      <span className={styles.cardChip}>
        <span className={styles.cardDot} aria-hidden="true" />
        {row.causeLabel}
      </span>
      {preview ? (
        <p className={styles.cardObituary}>{getObituaryLead(row.obituary)}</p>
      ) : (
        // A scrollable region must be reachable by keyboard (focusable) to be scrolled without a pointer.
        <p className={`${styles.cardObituary} ${styles.cardObituaryFull}`} tabIndex={0} aria-label={`Obituary of ${row.name}`}>
          {row.obituary}
        </p>
      )}
      <dl className={styles.cardGrid}>
        <div>
          <dt>Died</dt>
          <dd>{row.deathDateLabel}</dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>{row.peakLabel ?? <span title="Peak market cap not recorded">not recorded</span>}</dd>
        </div>
        <div>
          <dt>Peg</dt>
          <dd>{row.pegCurrency}</dd>
        </div>
        <div>
          <dt>Record</dt>
          <dd>{row.tracked ? "Tracked archive" : "Curated"}</dd>
        </div>
      </dl>
      {preview ? (
        <p className={styles.cardHint}>
          Click to pin the full obituary.{flowerLine ? <span className={styles.cardCount}> {flowerLine}</span> : null}
        </p>
      ) : (
        <>
          <ul className={styles.cardLinks}>
            <li>
              <a href={row.sourceUrl} target="_blank" rel="noopener noreferrer">
                Source<span aria-hidden="true">&nbsp;↗</span>
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
            {row.archivedUrl ? (
              <li>
                <Link href={row.archivedUrl}>
                  Archived data<span aria-hidden="true">&nbsp;→</span>
                </Link>
              </li>
            ) : null}
            {row.caseStudy ? (
              <li>
                <Link href={`/learn/case-studies/${row.caseStudy.slug}/`}>
                  Case study<span aria-hidden="true">&nbsp;→</span>
                </Link>
              </li>
            ) : null}
            {row.mechanismArchetype ? (
              <li>
                <Link href={getMechanismExplainerPath(row.mechanismArchetype)}>
                  Mechanism explainer<span aria-hidden="true">&nbsp;→</span>
                </Link>
              </li>
            ) : null}
            <li>
              <a
                className={styles.cardRegister}
                href={`#${row.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  onReadRegister();
                }}
              >
                Read in the register<span aria-hidden="true">&nbsp;↓</span>
              </a>
            </li>
          </ul>
          <p className={styles.cardFlowerRow}>
            <button type="button" className={styles.cardFlower} onClick={onLeaveFlower}>
              Leave a flower
            </button>
            {flowerLine ? <span className={styles.cardCount}>{flowerLine}</span> : null}
          </p>
        </>
      )}
    </article>
  );
}
