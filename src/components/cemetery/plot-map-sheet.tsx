"use client";

/**
 * Stablecoin Cemetery plot map: the phone and touch-tablet bottom sheet (`PLOT_PORTRAIT_QUERY`). A non-modal dialog
 * holding the pinned grave's `PlotMapRecordCard`, portalled to `<body>` so its z-order is explicit against the app
 * chrome: it sits on `--mobile-bottom-nav-safe-height` (never under `MobileBottomNav`, z 55) at z 56, above the
 * utility dock (z 50).
 *
 * The sheet stays mounted while the portrait layer is live; closed it is `inert` and slides out, keeping its last
 * record so the exit transition does not blank. When its body overflows vertically (e.g. long obituaries at 320 px),
 * top/bottom edge fades cue scrollability and disappear once scrolled to each edge, and extra bottom padding keeps
 * the last control ("Leave a flower") cleanly clear of the bottom navigation bar.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import { createPortal } from "react-dom";
import type { PlotLogoAtlas } from "@/lib/cemetery-plot-map-input";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { EDITORIAL_TITLES } from "@/lib/cemetery-editorial";
import { PlotMapRecordCard } from "./plot-map-record-card";
import { plotTokenStyle } from "./plot-map-shapes";
import plotStyles from "./plot-map.module.css";
import styles from "./plot-map-mobile.module.css";

export interface PlotMapSheetProps {
  /** The record shown (kept after close so the exit transition keeps its content). */
  row: CemeteryRegisterRow | null;
  open: boolean;
  atlas: PlotLogoAtlas;
  flowers: number;
  onLeaveFlower: () => void;
  onReadRegister: () => void;
  onClose: () => void;
  sheetRef: Ref<HTMLDivElement>;
}

export function PlotMapSheet({ row, open, atlas, flowers, onLeaveFlower, onReadRegister, onClose, sheetRef }: PlotMapSheetProps): ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<{ top: boolean; bottom: boolean }>({ top: false, bottom: false });

  const syncOverflow = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setOverflow((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Reset scroll to the top when opening a different grave so the sheet starts on its kicker and title.
  const rowId = row?.id ?? null;
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    syncOverflow();
  }, [rowId, open, syncOverflow]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    syncOverflow();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncOverflow);
    observer?.observe(el);
    window.addEventListener("resize", syncOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncOverflow);
    };
  }, [open, rowId, flowers, syncOverflow]);

  return createPortal(
    <div className={plotStyles.tokens} style={plotTokenStyle(atlas)}>
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="false"
        aria-labelledby={row ? "plot-card-title-sheet" : undefined}
        tabIndex={-1}
        inert={!open}
        data-open={open}
        data-overflow-top={overflow.top ? "true" : undefined}
        data-overflow-bottom={overflow.bottom ? "true" : undefined}
        data-plot-sheet
      >
        <div className={styles.sheetFadeTop} aria-hidden="true" />
        <div ref={bodyRef} className={styles.sheetBody} onScroll={syncOverflow} data-plot-sheet-body>
          {row ? (
            <PlotMapRecordCard
              row={row}
              editorialTitle={EDITORIAL_TITLES[row.id]}
              flowers={flowers}
              onLeaveFlower={onLeaveFlower}
              onReadRegister={onReadRegister}
              onClose={onClose}
              variant="sheet"
            />
          ) : null}
        </div>
        <div className={styles.sheetFadeBottom} aria-hidden="true" data-plot-sheet-fade />
      </div>
    </div>,
    document.body,
  );
}
