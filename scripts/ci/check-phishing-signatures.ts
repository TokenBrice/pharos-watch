#!/usr/bin/env node
/**
 * Scans built static HTML for inline-script patterns that match
 * credential-harvesting phishing kits. Prevents shipping a sanitizer-style
 * inline script that gets pharos.watch flagged by Safe Browsing again.
 *
 * Any unallowlisted red-pattern match in an inline <script> is deploy-blocking:
 *
 *   - history.replaceState near credential-shaped identifiers
 *   - URLSearchParams over window.location.hash
 *   - window.__*_TOKEN__ / window.__*_KEY__ assignments
 *   - try{...location.hash...replaceState...} the textbook phishing shape
 *
 * Reads `out/` after `npm run build`. Allowlist per page is keyed by
 * relative HTML path; entries are deliberately rare — most pages should
 * have zero matches.
 */

import fs from "node:fs";
import path from "node:path";
import { walkOutFiles } from "../lib/seo-sitemap.mjs";

const OUT_DIR = path.resolve("out");

/** Routes that are permitted to carry specific patterns inline. */
const ALLOWLIST = new Map<string, Set<string>>([
  // example shape:
  // ["api/index.html", new Set(["url-hash-token-extraction"])],
]);

interface Signature {
  id: string;
  severity: "red";
  test: (script: string) => boolean;
}

const SIGNATURES: Signature[] = [
  {
    id: "history-replacestate-near-credential",
    severity: "red",
    test: (script) =>
      /history\.replaceState/.test(script) && /\b(verify|token|auth|key|session|otp|magic)\b/i.test(script),
  },
  {
    id: "url-hash-token-extraction",
    severity: "red",
    test: (script) => /URLSearchParams\s*\(/.test(script) && /(window\.)?location\.hash/.test(script),
  },
  {
    id: "token-shaped-window-global",
    severity: "red",
    test: (script) => /window\.__[A-Z][A-Z0-9_]*(TOKEN|KEY|SECRET|AUTH)__/.test(script),
  },
  {
    id: "phishing-kit-shape",
    severity: "red",
    // The textbook structure: try{...read hash...replaceState...}
    test: (script) => /try\s*\{[\s\S]*location\.hash[\s\S]*replaceState[\s\S]*\}\s*catch/.test(script),
  },
];

/** Extract the textual content of every inline <script>...</script> block. */
function hasSrcAttribute(openTag: string): boolean {
  let index = "<script".length;
  while (index < openTag.length) {
    while (index < openTag.length && /[\s/]/.test(openTag[index] ?? "")) index += 1;
    const nameStart = index;
    while (index < openTag.length && /[^\s=/>]/.test(openTag[index] ?? "")) index += 1;
    const name = openTag.slice(nameStart, index).toLowerCase();
    if (!name) {
      index += 1;
      continue;
    }
    while (index < openTag.length && /\s/.test(openTag[index] ?? "")) index += 1;
    if (openTag[index] !== "=") {
      index += 1;
      continue;
    }
    index += 1;
    while (index < openTag.length && /\s/.test(openTag[index] ?? "")) index += 1;
    const quote = openTag[index];
    if (quote === "\"" || quote === "'") {
      index += 1;
      const valueEnd = openTag.indexOf(quote, index);
      index = valueEnd < 0 ? openTag.length : valueEnd + 1;
    } else {
      while (index < openTag.length && /[^\s>]/.test(openTag[index] ?? "")) index += 1;
    }
    if (name === "src") {
      return true;
    }
  }
  return false;
}

function isScriptTagOpen(lowerHtml: string, openStart: number): boolean {
  const next = lowerHtml[openStart + "<script".length] ?? "";
  return next === "" || /[\s/>]/.test(next);
}

function findNextScriptOpen(html: string, lowerHtml: string, searchFrom: number): number {
  while (true) {
    const openStart = lowerHtml.indexOf("<script", searchFrom);
    if (openStart < 0) return -1;

    const commentStart = html.indexOf("<!--", searchFrom);
    if (commentStart >= 0 && commentStart < openStart) {
      const commentEnd = html.indexOf("-->", commentStart + "<!--".length);
      if (commentEnd < 0) return -1;
      searchFrom = commentEnd + "-->".length;
      continue;
    }

    if (isScriptTagOpen(lowerHtml, openStart)) return openStart;
    searchFrom = openStart + "<script".length;
  }
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const lowerHtml = html.toLowerCase();
  let searchFrom = 0;
  while (true) {
    const openStart = findNextScriptOpen(html, lowerHtml, searchFrom);
    if (openStart < 0) break;
    const openEnd = lowerHtml.indexOf(">", openStart);
    if (openEnd < 0) break;
    const closeStart = lowerHtml.indexOf("</script", openEnd + 1);
    if (closeStart < 0) break;

    const openTag = html.slice(openStart, openEnd + 1);
    if (!hasSrcAttribute(openTag)) {
      const body = html.slice(openEnd + 1, closeStart);
      if (body.trim().length > 0) {
        scripts.push(body);
      }
    }
    searchFrom = closeStart + "</script".length;
  }
  return scripts;
}

function relPath(file: string): string {
  return path.relative(OUT_DIR, file).replace(/\\/g, "/");
}

interface PhishingFinding {
  signature: string;
  severity: "red";
  scriptIndex: number;
  preview: string;
}

function scanFile(file: string): PhishingFinding[] {
  const html = fs.readFileSync(file, "utf8");
  const scripts = extractInlineScripts(html);
  const findings: PhishingFinding[] = [];
  const allowed = ALLOWLIST.get(relPath(file)) ?? new Set();
  for (const [scriptIndex, script] of scripts.entries()) {
    for (const sig of SIGNATURES) {
      if (!sig.test(script)) continue;
      if (allowed.has(sig.id)) continue;
      findings.push({
        signature: sig.id,
        severity: sig.severity,
        scriptIndex,
        preview: script.slice(0, 180).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return findings;
}

function main(): void {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`[check:phishing-signatures] out/ directory missing — run \`npm run build\` first.`);
    process.exit(2);
  }

  const files = [...walkOutFiles(OUT_DIR, (name) => name.endsWith(".html"))];
  const violations: Array<{ file: string; findings: PhishingFinding[] }> = [];
  for (const file of files) {
    const findings = scanFile(file);
    if (findings.length === 0) continue;
    violations.push({ file: relPath(file), findings });
  }

  if (violations.length === 0) {
    console.log(`OK: Scanned ${files.length} HTML pages — no phishing-kit signatures in inline scripts.`);
    return;
  }

  console.error("");
  console.error("✗ Inline-script phishing-kit signatures detected:");
  console.error("");
  for (const { file, findings } of violations) {
    console.error(`  ${file}`);
    for (const finding of findings) {
      console.error(`    [${finding.severity}] ${finding.signature} (script #${finding.scriptIndex})`);
      console.error(`      → ${finding.preview}…`);
    }
  }
  console.error("");
  console.error("These patterns are structurally identical to credential-harvesting");
  console.error("phishing kits and will trip Google Safe Browsing's social-engineering");
  console.error("classifier. Move the logic into a route-scoped client component, or");
  console.error("if the pattern is genuinely required, add an explicit allowlist entry");
  console.error("in scripts/ci/check-phishing-signatures.ts documenting why.");
  console.error("");
  console.error(`Total: ${violations.length} file(s) with violations.`);
  process.exit(1);
}

main();
