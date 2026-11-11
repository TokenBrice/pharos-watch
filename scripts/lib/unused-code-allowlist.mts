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
  "shared/types/pharosville.ts":
    "Payload schema and version of the external PharosVille API contract. Its only local importer is shared/lib/pharosville-api-contract.ts, which the standalone app consumes (entry above), so no production import edge exists.",
  "worker/src/lib/og-harfbuzz.ts":
    "Wrangler's [alias] table maps the external `harfbuzzjs` specifier to this module; its only importer is satori inside node_modules, so no local static import edge exists.",
};

/** Exports whose only consumers are invisible to the static scan. */
export const SCANNER_BLIND_SPOT_EXPORTS: Record<string, string> = {};
export const DEBT_MODULES: Record<string, string> = {
  "shared/types/safety-score-v9-operational-resilience-overlays.ts":
    "Schema of the retired operational-resilience overlay file. Nothing in production reads it; its only importer is shared/types/__tests__/safety-score-v9-overlays.test.ts with a one-row historical fixture. The types barrel hid this until it was removed on 2026-11-11. Delete it with its fixture and test, or give it a reader: owner decision.",
};

/** Unreferenced exports kept on purpose; deletion is a separate pass. */
export const DEBT_EXPORTS: Record<string, string> = {};
