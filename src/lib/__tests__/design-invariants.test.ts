import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inspectComponentStyles, isComponentSourceFile } from "./design-invariants.test-support";

/**
 * Design invariants guarded at the repo level so a future commit cannot
 * silently introduce Newsreader serif or Tailwind's `font-serif` into a
 * non-editorial surface. The Daily Digest, the detail-page AI summary and the
 * Stablecoin Cemetery (h1, epitaphs, record card) are the intentional
 * carve-outs per docs/design-language.md.
 */

const ROOT = process.cwd();
const COMPONENTS_DIR = join(ROOT, "src/components");

// Relative posix-style paths (for stable match regardless of OS separator).
const ALLOWED_SERIF_FILES: Record<string, true> = {
  "src/components/ai-summary.tsx": true,
  // The clamped-prose client half of the AI summary carries the same serif
  // editorial carve-out as its parent.
  "src/components/ai-summary-prose.tsx": true,
  // Cemetery Autopsy Register epitaph pull line: Newsreader as an intentional
  // editorial carve-out (Design Council B11), matching the Digest register.
  "src/components/cemetery/cemetery-register-autopsy.tsx": true,
  // Cemetery hero h1 (plot map redesign): the same sanctioned cemetery carve-out.
  "src/components/cemetery/cemetery-hero.tsx": true,
  // Plot-map record card (desktop inspector and phone sheet): name, editorial title and epitaph in Newsreader.
  "src/components/cemetery/plot-map-record-card.tsx": true,
  // Root error boundary keeps its editorial register in Georgia
  // (`font-serif`), deliberately not Newsreader: error.tsx is in every
  // route's preload graph, and importing digestDisplay from it preloaded
  // the digest font CSS app-wide (mythos design review #19).
  "src/components/page-error-editorial.tsx": true,
  // Existing Digest surfaces import the font by its digestDisplay alias.
  "src/components/daily-digest.tsx": true,
  "src/components/home-alt-mini-cards/daily-digest-card.tsx": true,
};

function toPosixRel(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (isComponentSourceFile(toPosixRel(full))) {
      out.push(full);
    }
  }
  return out;
}

// Collected once: both invariants scan the same component tree.
const COMPONENT_SOURCES = walk(COMPONENTS_DIR).map((file) => {
  const rel = toPosixRel(file);
  return { rel, violations: inspectComponentStyles(rel, readFileSync(file, "utf8")) };
});

describe("design invariants", () => {
  it("never uses Tailwind max-* variants (this pipeline does not emit them)", () => {
    const offenders = COMPONENT_SOURCES.filter(({ violations }) => violations.includes("max-breakpoint"))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it("font-serif / Newsreader usage is confined to editorial carve-outs", () => {
    const offenders: string[] = [];

    for (const { rel, violations } of COMPONENT_SOURCES) {
      if (ALLOWED_SERIF_FILES[rel]) continue;
      // Digest editorial surfaces — any current or future file under the
      // digest directory is allowed its serif treatment.
      if (rel.includes("/digest-") || rel.includes("/digest/")) continue;
      if (violations.includes("serif")) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it.each([
    ["JSX breakpoint class", '<div className="max-lg:hidden" />', ["max-breakpoint"]],
    ["JSX serif class", '<div className="font-serif" />', ["serif"]],
    ["conditional class", '<div className={ready ? "font-serif" : "font-sans"} />', ["serif"]],
    ["template class", '<div className={`max-md:hidden ${extra}`} />', ["max-breakpoint"]],
    ["referenced class", 'const tone = "font-serif"; const classes = tone; <div className={classes} />', ["serif"]],
    ["class construction", 'const classes = cn("max-sm:hidden");', ["max-breakpoint"]],
    ["aliased class construction", 'import { clsx as classes } from "clsx"; classes("font-serif");', ["serif"]],
    ["variant construction", 'const variants = cva("base", { variants: { tone: { editorial: "font-serif" } } });', ["serif"]],
    ["class prop", 'const props = { tableClassName: "max-xl:hidden" };', ["max-breakpoint"]],
    ["font import", 'import { Newsreader as Serif } from "next/font/google";', ["serif"]],
    ["editorial font import", 'import { digestDisplay as serif } from "@/lib/fonts/digest";', ["serif"]],
    ["local font", 'import font from "next/font/local"; font({ src: "./Newsreader.woff2" });', ["serif"]],
    ["comments", '// Avoid font-serif, Newsreader and max-lg: here\n<div className="font-sans">{/* font-serif max-sm: */}Safe</div>', []],
    ["display text", 'const message = "font-serif Newsreader max-lg:"; <p>{message}</p>', []],
    ["type-only import", 'import type { Newsreader } from "next/font/google";', []],
    ["type-only specifier", 'import { type Newsreader } from "next/font/google";', []],
  ] as const)("scopes design violations to runtime styling: %s", (_name, source, expected) => {
    expect(inspectComponentStyles("src/components/example.tsx", source)).toEqual(expected);
  });

  it.each([
    "src/components/__tests__/example.tsx",
    "src/components/example.test.tsx",
    "src/components/example.spec.tsx",
    "src/components/example.test-support.ts",
    "src/components/__fixtures__/example.tsx",
  ])("excludes test-only styling in %s", (path) => {
    expect(isComponentSourceFile(path)).toBe(false);
    expect(inspectComponentStyles(path, '<div className="font-serif max-lg:hidden" />')).toEqual([]);
  });
});
