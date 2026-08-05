#!/usr/bin/env tsx
/**
 * Refreshes the markdown-export snapshot fixtures asserted by
 * scripts/__tests__/generate-markdown-exports.test.ts. Each fixture is
 * re-rendered through the exact renderer the test calls, so the fixture can
 * never drift from renderer behavior — only from stale source data.
 *
 * Run this whenever a covered source changes, otherwise the snapshot test
 * fails on the next PR:
 *   - changelog-index.md      <- src/data/changelogs/ (new weekly entry)
 *   - methodology-index.md    <- shared methodology changelog registry
 *   - stablecoin-usdt-tether.md <- USDT registry metadata
 *
 * Usage:
 *   npm run refresh:markdown-fixtures
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMethodologyIndexMarkdown } from "../lib/methodology-to-markdown";
import { renderChangelogIndex, renderStablecoinDetail } from "../lib/markdown-renderers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES_DIR = join(ROOT, "scripts/__tests__/fixtures/markdown");

const fixtures: ReadonlyArray<{ readonly file: string; readonly render: () => string }> = [
  { file: "changelog-index.md", render: () => renderChangelogIndex() },
  { file: "methodology-index.md", render: () => buildMethodologyIndexMarkdown() },
  { file: "stablecoin-usdt-tether.md", render: () => renderStablecoinDetail("usdt-tether") },
];

for (const { file, render } of fixtures) {
  writeFileSync(join(FIXTURES_DIR, file), render());
  console.log(`refreshed ${file}`);
}
