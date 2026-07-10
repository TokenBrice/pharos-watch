/* eslint-disable security/detect-non-literal-fs-filename -- test-only directory walker rooted at process.cwd() */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Design invariants guarded at the repo level so a future commit cannot
 * silently introduce Newsreader serif or Tailwind's `font-serif` into a
 * non-editorial surface. The Daily Digest and the detail-page AI summary
 * are the only two intentional carve-outs per docs/design-language.md.
 */

const ROOT = process.cwd();
const COMPONENTS_DIR = join(ROOT, "src/components");
const APP_GLOBALS = join(ROOT, "src/app/globals.css");

// Relative posix-style paths (for stable match regardless of OS separator).
const ALLOWED_SERIF_FILES = new Set<string>([
  "src/components/ai-summary.tsx",
  // Cemetery obituaries use Newsreader display titles as an intentional
  // editorial carve-out (Design Council B11), matching the Digest register.
  "src/components/cemetery-tombstones.tsx",
  // Root error boundary keeps its editorial register in Georgia
  // (`font-serif`), deliberately not Newsreader: error.tsx is in every
  // route's preload graph, and importing digestDisplay from it preloaded
  // the digest font CSS app-wide (mythos design review #19).
  "src/components/page-error-editorial.tsx",
]);

function toPosixRel(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("design invariants", () => {
  it("resolves the display font token from the body-level font bridge", () => {
    const globals = readFileSync(APP_GLOBALS, "utf8");

    expect(globals).toMatch(/body\s*{[^}]*--font-pharos-display:\s*var\(\s*--font-bricolage,/s);
    expect(globals).not.toMatch(/ABC Whyte Inktrap|abc-whyte-inktrap/);
    expect(globals).not.toMatch(/:root\s*{[^}]*--font-pharos-display:/s);
  });

  it("font-serif / Newsreader usage is confined to editorial carve-outs", () => {
    const files = walk(COMPONENTS_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      const rel = toPosixRel(file);
      if (ALLOWED_SERIF_FILES.has(rel)) continue;
      // Digest editorial surfaces — any current or future file under the
      // digest directory is allowed its serif treatment.
      if (rel.includes("/digest-") || rel.includes("/digest/")) continue;
      const src = readFileSync(file, "utf8");
      if (/\bfont-serif\b|\bNewsreader\b/.test(src)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
