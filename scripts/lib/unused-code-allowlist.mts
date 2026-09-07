/**
 * Allowlists for scripts/ci/check-unused-code.ts.
 *
 * Two sections, deliberately separate:
 *
 * - SCANNER_BLIND_SPOTS — the consumer exists, but the static import graph cannot
 *   see it (string-keyed consumers, generated-artifact text, and the like). These
 *   entries are permanent until the scanner learns the pattern.
 * - DEBT — the finding is real: nothing imports the module or export, and it is
 *   kept on purpose or until a deletion pass reaches it. Target: empty. Removing
 *   an entry from here is a real cleanup; adding one needs a checkable reason.
 *
 * DEBT previously held 106 entries whose claims had rotted: most symbols were
 * only ever used inside their own module and simply needed the `export` keyword
 * dropped, several had acquired genuine importers, and a batch named modules
 * that no longer declared the symbol at all because it had moved behind a
 * barrel re-export. The audit could not see any of that, so the list grew and
 * stopped meaning anything. The checker now rejects an entry whose finding has
 * gone away, whose keyed module only re-exports the symbol, or which duplicates
 * the vendored `src/components/ui/**` path policy.
 *
 * Every entry carries a one-line reason. The allowlist audit fails on a missing
 * reason, a missing file, or a symbol the file no longer exports, so entries
 * cannot rot silently.
 *
 * Export keys are "<repo-relative path>::<exported symbol>"; module keys are the
 * repo-relative path.
 */

/** Modules whose only importers are invisible to the static scan. */
export const SCANNER_BLIND_SPOT_MODULES: Record<string, string> = {
  "shared/lib/pharosville-api-contract.ts":
    "External consumer contract: the standalone PharosVille app (docs/architecture.md) validates against these schemas, so no local production importer is expected; local references are tests and deploy path-filter metadata.",
};

/** Exports whose only consumers are invisible to the static scan. */
export const SCANNER_BLIND_SPOT_EXPORTS: Record<string, string> = {
  "src/components/chart-primitives/data-table.tsx::ChartDataTable":
    "scripts/ci/check-table-primitives.ts matches the exported component name as a string, not through an import.",
  "shared/lib/telegram-mini-app-contract.ts::TelegramDewsBand":
    "Public Mini App typing contract; external Mini App code consumes this surface, which the src/app/pharoswatchbot/app/types.ts barrel re-exports for it.",
  "shared/lib/telegram-mini-app-contract.ts::TelegramSafetyMode":
    "Public Mini App typing contract; external Mini App code consumes this surface, which the src/app/pharoswatchbot/app/types.ts barrel re-exports for it.",
};
export const DEBT_MODULES: Record<string, string> = {
  "shared/data/safety-score-v9/matched-invariants-v1.ts":
    "Curated matched-invariant corpus for the publication-exact safety-score equivalence suites; deliberately test-only, not product data.",
};

/** Unreferenced exports kept on purpose; deletion is a separate pass. */
export const DEBT_EXPORTS: Record<string, string> = {};
