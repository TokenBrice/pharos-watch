/* eslint-disable security/detect-non-literal-fs-filename -- test reads
   fixed allowlist + digest data fixtures rooted at process.cwd(). */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DigestStoredSnapshotSchema } from "@shared/types/digest";

/**
 * Guard the Newsreader subset: every glyph that the digest surface can mount
 * — both /digest/* and the homepage <DailyDigest> — must be inside
 * `data/fonts/glyphs-allowlist.txt`. If a future digest author introduces a
 * glyph outside the subset (e.g. a coin name with a non-Latin-1 character),
 * this test fails so the allowlist + woff2 can be regenerated before the
 * digest ships to readers.
 *
 * The body of every digest uses `EDITORIAL_BODY_STYLE` (Courier system
 * font), so only the headline strings need allowlist coverage today.
 */

const ROOT = process.cwd();

function parseAllowlist(path: string): Array<[number, number]> {
  const raw = readFileSync(path, "utf8");
  const ranges: Array<[number, number]> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    // eslint-disable-next-line security/detect-unsafe-regex
    const match = trimmed.match(/^U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/);
    if (!match) {
      throw new Error(`Invalid allowlist entry: ${trimmed}`);
    }
    const lo = parseInt(match[1], 16);
    const hi = match[2] ? parseInt(match[2], 16) : lo;
    ranges.push([lo, hi]);
  }
  return ranges;
}

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function missingGlyphs(text: string, ranges: Array<[number, number]>): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (!inRanges(cp, ranges)) {
      out.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} (${JSON.stringify(ch)})`);
    }
  }
  return out;
}

describe("Newsreader subset allowlist", () => {
  it("covers every digest title glyph", () => {
    const ranges = parseAllowlist(join(ROOT, "data/fonts/glyphs-allowlist.txt"));
    const raw = readFileSync(join(ROOT, "data/digests.json"), "utf8");
    const digests = DigestStoredSnapshotSchema.parse(JSON.parse(raw));

    const offenders: Array<{ title: string; missing: string[] }> = [];
    for (const entry of digests) {
      const missing = missingGlyphs(entry.title ?? "", ranges);
      if (missing.length > 0) {
        offenders.push({ title: entry.title, missing });
      }
    }

    expect(offenders).toEqual([]);
  });
});
