#!/usr/bin/env tsx
/**
 * Validates that every `MechanismArchetype` value has a complete
 * `/learn/mechanisms/<slug>/` explainer wired up end-to-end:
 *
 *  1. Editorial label in `MECHANISM_ARCHETYPE_LABELS`.
 *  2. Editorial one-liner in `MECHANISM_ARCHETYPE_ONE_LINERS`.
 *  3. Content module entry in `ARCHETYPE_CONTENT` with non-stub
 *     `headline`/`subtitle` and at least one `representativeCoins[*]`
 *     whose `coinId` resolves via `TRACKED_META_BY_ID`.
 *  4. Dynamic route file present at
 *     `src/app/learn/mechanisms/[archetype]/page.tsx`, with its
 *     `generateStaticParams()` covering every archetype.
 *  5. Sitemap entry at `/learn/mechanisms/<slug>/` for every archetype.
 *
 * Exits non-zero on any failure with one line per failed assertion.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MECHANISM_ARCHETYPE_VALUES, type MechanismArchetype } from "../../shared/types";
import {
  MECHANISM_ARCHETYPE_LABELS,
  MECHANISM_ARCHETYPE_ONE_LINERS,
} from "../../shared/lib/classification";
import { TRACKED_META_BY_ID } from "../../shared/lib/stablecoins/registry";
import { ARCHETYPE_CONTENT } from "../../src/app/learn/mechanisms/content";
import sitemap from "../../src/app/sitemap";
import * as archetypePage from "../../src/app/learn/mechanisms/[archetype]/page";
import { SITE_ORIGIN } from "../../shared/lib/runtime-origins";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROUTE_PAGE_PATH = "src/app/learn/mechanisms/[archetype]/page.tsx";

export interface ArchetypeExplainerFinding {
  archetype: MechanismArchetype | "*";
  message: string;
}

export interface ArchetypeExplainerCheckResult {
  findings: ArchetypeExplainerFinding[];
  /** Set of archetype slugs that had at least one finding. */
  failedArchetypes: Set<MechanismArchetype | "*">;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function startsWithStub(value: string): boolean {
  return value.trim().toLowerCase().startsWith("stub");
}

export function validateArchetypeExplainerCoverage(): ArchetypeExplainerCheckResult {
  const findings: ArchetypeExplainerFinding[] = [];
  const failedArchetypes = new Set<MechanismArchetype | "*">();

  function record(archetype: MechanismArchetype | "*", message: string): void {
    findings.push({ archetype, message });
    failedArchetypes.add(archetype);
  }

  // (4a) Dynamic route file exists. Verified once.
  if (!existsSync(resolve(process.cwd(), ROUTE_PAGE_PATH))) {
    record("*", `missing dynamic route file: ${ROUTE_PAGE_PATH}`);
  }

  // (4b) generateStaticParams round-trips every archetype.
  const generatedParams = archetypePage.generateStaticParams() as Array<{ archetype: string }>;
  const generatedSlugs = new Set(generatedParams.map((entry) => entry.archetype));

  // (5) Sitemap entries for every archetype.
  const sitemapEntries = sitemap();
  const sitemapUrls = new Set(sitemapEntries.map((entry) => entry.url));

  for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
    // (1) Label.
    const label = MECHANISM_ARCHETYPE_LABELS[archetype];
    if (!isNonEmpty(label)) {
      record(archetype, "MECHANISM_ARCHETYPE_LABELS entry is missing or empty");
    }

    // (2) One-liner.
    const oneLiner = MECHANISM_ARCHETYPE_ONE_LINERS[archetype];
    if (!isNonEmpty(oneLiner)) {
      record(archetype, "MECHANISM_ARCHETYPE_ONE_LINERS entry is missing or empty");
    }

    // (3) Content module.
    const content = ARCHETYPE_CONTENT[archetype];
    if (!content) {
      record(archetype, "ARCHETYPE_CONTENT entry is missing");
    } else {
      if (!isNonEmpty(content.headline)) {
        record(archetype, "ARCHETYPE_CONTENT.headline is missing or empty");
      } else if (startsWithStub(content.headline)) {
        record(archetype, `ARCHETYPE_CONTENT.headline still uses placeholder copy: "${content.headline}"`);
      }
      if (!isNonEmpty(content.subtitle)) {
        record(archetype, "ARCHETYPE_CONTENT.subtitle is missing or empty");
      } else if (startsWithStub(content.subtitle)) {
        record(archetype, `ARCHETYPE_CONTENT.subtitle still uses placeholder copy: "${content.subtitle}"`);
      }
      if (!content.representativeCoins || content.representativeCoins.length < 1) {
        record(archetype, "ARCHETYPE_CONTENT.representativeCoins must list at least one coin");
      } else {
        for (const coin of content.representativeCoins) {
          if (!TRACKED_META_BY_ID.has(coin.coinId)) {
            record(
              archetype,
              `representativeCoins coinId "${coin.coinId}" does not resolve via TRACKED_META_BY_ID`,
            );
          }
        }
      }
    }

    // (4b) Slug present in generateStaticParams output.
    if (!generatedSlugs.has(archetype)) {
      record(
        archetype,
        `generateStaticParams() does not include "${archetype}" (got: ${[...generatedSlugs].sort().join(", ") || "<empty>"})`,
      );
    }

    // (5) Sitemap entry.
    const expectedSitemapUrl = `${SITE_ORIGIN}/learn/mechanisms/${archetype}/`;
    if (!sitemapUrls.has(expectedSitemapUrl)) {
      record(
        archetype,
        `sitemap is missing entry for ${expectedSitemapUrl} — wire it into src/app/sitemap.ts`,
      );
    }
  }

  return { findings, failedArchetypes };
}

function runCli(): void {
  const result = validateArchetypeExplainerCoverage();

  const findingsByArchetype = new Map<MechanismArchetype | "*", string[]>();
  for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
    findingsByArchetype.set(archetype, []);
  }
  findingsByArchetype.set("*", []);
  for (const finding of result.findings) {
    const bucket = findingsByArchetype.get(finding.archetype) ?? [];
    bucket.push(finding.message);
    findingsByArchetype.set(finding.archetype, bucket);
  }

  // Per-archetype detail prints only on failure; success stays summary-only.
  for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
    const messages = findingsByArchetype.get(archetype) ?? [];
    if (messages.length > 0) {
      process.stderr.write(`  ${archetype}: FAIL\n`);
      for (const message of messages) {
        process.stderr.write(`    - ${message}\n`);
      }
    }
  }

  const globalMessages = findingsByArchetype.get("*") ?? [];
  if (globalMessages.length > 0) {
    process.stderr.write(`  <route>: FAIL\n`);
    for (const message of globalMessages) {
      process.stderr.write(`    - ${message}\n`);
    }
  }

  if (result.findings.length > 0) {
    process.stderr.write(
      `archetype explainer coverage check failed: ${result.findings.length} finding(s) across ${result.failedArchetypes.size} archetype(s).\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `archetype explainer coverage OK: ${MECHANISM_ARCHETYPE_VALUES.length}/${MECHANISM_ARCHETYPE_VALUES.length} archetypes fully wired.\n`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCli();
}
