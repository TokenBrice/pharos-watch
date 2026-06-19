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
const ALLOWLIST = new Map([
  // example shape:
  // ["api/index.html", new Set(["url-hash-token-extraction"])],
]);

/** @typedef {{ id: string; severity: "red"; test: (script: string) => boolean }} Signature */

/** @type {Signature[]} */
const SIGNATURES = [
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
function extractInlineScripts(html) {
  const inline = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1];
    if (/(?:^|\s)src\s*=/i.test(attributes)) continue;
    const body = match[2];
    if (body.trim().length === 0) continue;
    inline.push(body);
  }
  return inline;
}


function relPath(file) {
  return path.relative(OUT_DIR, file).replace(/\\/g, "/");
}

function scanFile(file) {
  const html = fs.readFileSync(file, "utf8");
  const scripts = extractInlineScripts(html);
  const findings = [];
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

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(`[check:phishing-signatures] out/ directory missing — run \`npm run build\` first.`);
    process.exit(2);
  }

  const files = [...walkOutFiles(OUT_DIR, (name) => name.endsWith(".html"))];
  const violations = [];
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
  console.error("in scripts/ci/check-phishing-signatures.mjs documenting why.");
  console.error("");
  console.error(`Total: ${violations.length} file(s) with violations.`);
  process.exit(1);
}

main();
