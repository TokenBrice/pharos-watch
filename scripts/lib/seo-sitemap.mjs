import fs from "node:fs";
import path from "node:path";

/**
 * Recursively yields files under `dir` (skipping `_next/`) whose names satisfy
 * `predicate`. Works for both HTML and index-file traversals.
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {Generator<string>}
 */
export function* walkOutFiles(dir, predicate) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_next") continue;
      yield* walkOutFiles(full, predicate);
      continue;
    }
    if (entry.isFile() && predicate(entry.name)) yield full;
  }
}

export function parseSitemapLocs(xml, { asSet = false } = {}) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let match = re.exec(xml);
  while (match) {
    locs.push(match[1]);
    match = re.exec(xml);
  }
  return asSet ? new Set(locs) : locs;
}

export function findDuplicateSitemapLocs(locs) {
  const seen = new Set();
  const duplicates = new Set();
  for (const loc of locs) {
    if (seen.has(loc)) duplicates.add(loc);
    else seen.add(loc);
  }
  return [...duplicates];
}
