// Single source of truth for the event classes that appear on /tape/.
// Imported by the filters chip row, the ItemList JSON-LD, the per-class label
// map in `@/lib/tape-class-style`, and the per-class "See all on Tape"
// deep-link footers on /depeg/, /freezewatch/, /flows/.
//
// Slugs match the first dot-segment of `tape_events.type` (per plan §3.3), and
// every entry has a live projector registered in
// `worker/src/cron/project-tape.ts`. Reserved chip slots were deleted by the
// 2026-08-09 ruling (WS8.8): a class earns a chip when its projector ships.

export interface TapeClassDef {
  slug: string;
  /** Short label shown on chips, digest rows, and ItemList entries. */
  label: string;
  /** Slightly longer label for the JSON-LD ItemList description. */
  description: string;
}

export const TAPE_CLASSES: readonly TapeClassDef[] = [
  { slug: "depeg",       label: "Depegs",        description: "Confirmed and pending peg deviations."             },
  { slug: "freeze",      label: "Freezes",       description: "Issuer freeze, unblock, and fund-destroy events."   },
  { slug: "score",       label: "Grade changes", description: "Stablecoin Safety Score upgrades and downgrades."   },
  { slug: "dews",        label: "DEWS bands",    description: "Depeg Early Warning System band transitions."       },
  { slug: "psi",         label: "PSI bands",     description: "Pharos Stability Index band shifts."                },
  { slug: "mint_burn",   label: "Mint/burn",     description: "Large single-transaction mint/burn flows."          },
  { slug: "yield",       label: "Yield",         description: "Yield warning signals and PYS drops."               },
  { slug: "methodology", label: "Methodology",   description: "Methodology version bumps."                         },
  { slug: "lifecycle",   label: "Lifecycle",     description: "Tracked coin lifecycle transitions."                },
  { slug: "cemetery",    label: "Cemetery",      description: "Additions to the stablecoin cemetery."              },
] as const;
