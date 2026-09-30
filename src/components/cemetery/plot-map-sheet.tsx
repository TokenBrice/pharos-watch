"use client";

/**
 * Stablecoin Cemetery plot map: the phone bottom sheet (≤ 760 px). A non-modal dialog holding the pinned grave's
 * `PlotMapRecordCard`, portalled to `<body>` so its z-order is explicit against the app chrome: it sits on
 * `--mobile-bottom-nav-safe-height` (never under `MobileBottomNav`, z 55) at z 56, above the utility dock (z 50).
 *
 * The sheet stays mounted while the portrait layer is; closed it is `inert` and slides out, keeping its last record
 * so the exit transition does not blank. Focus handling and scrolling live in `PlotMapPortraitSlot`.
 */
import type { ReactElement, Ref } from "react";
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
        data-plot-sheet
      >
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
    </div>,
    document.body,
  );
}
