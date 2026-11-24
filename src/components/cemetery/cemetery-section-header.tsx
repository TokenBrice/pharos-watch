import type { ReactNode } from "react";
import styles from "./cemetery-below-fold.module.css";

export interface CemeterySectionHeaderProps {
  /** Id of the heading element, for the section's `aria-labelledby`. */
  id?: string;
  kicker: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}

/** Signpost-plate kicker, Newsreader title and meta line shared by every below-fold cemetery section. */
export function CemeterySectionHeader({ id, kicker, title, meta, actions, level = 2 }: CemeterySectionHeaderProps) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-3xl space-y-1.5">
        <p className={styles.kicker}>{kicker}</p>
        <Heading id={id} className={level === 3 ? styles.cardTitle : styles.sectionTitle}>
          {title}
        </Heading>
        {meta ? <p className="pharos-meta">{meta}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
