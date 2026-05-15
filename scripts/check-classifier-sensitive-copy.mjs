#!/usr/bin/env node
/**
 * Scans classifier-sensitive public pages for wallet-drainer, phishing, or
 * browser-warning copy that can look deceptive when paired with API keys,
 * wallet addresses, Telegram bots, or support language.
 *
 * This is intentionally scoped. Broad docs/methodology scans would generate
 * false positives because incident runbooks legitimately mention these terms.
 */

import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const OUT_DIR = path.resolve("out");

const SENSITIVE_PAGES = [
  { file: "api/index.html", route: "/api/" },
  { file: "funding/index.html", route: "/funding/" },
  { file: "pharoswatchbot/index.html", route: "/pharoswatchbot/" },
];

const FORBIDDEN_COPY = [
  { id: "seed-phrase", terms: ["seed phrase", "recovery phrase"] },
  { id: "private-key", terms: ["private key"] },
  { id: "connect-wallet", terms: ["wallet connect", "connect wallet", "connect your wallet"] },
  { id: "verify-wallet", terms: ["verify wallet", "verify your wallet", "validate wallet", "sync wallet"] },
  { id: "claim-or-airdrop", terms: ["claim tokens", "claim your tokens", "claim rewards", "airdrop"] },
  { id: "transaction-approval", terms: ["approve transaction", "approve this transaction", "sign message", "sign this message"] },
  { id: "browser-warning-copy", terms: ["dangerous site", "back to safety", "security warning", "fix your browser"] },
  { id: "urgency-pressure", terms: ["urgent action required", "act now to secure"] },
];

function stripHtml(html) {
  const document = new JSDOM(html).window.document;
  document.querySelectorAll("script, style").forEach((node) => node.remove());
  return (document.body?.textContent ?? document.documentElement.textContent ?? "").replace(/\s+/g, " ");
}

function preview(text, index) {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 120);
  return text.slice(start, end).trim();
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error("[check:classifier-sensitive-copy] out/ directory missing — run `npm run build` first.");
    process.exit(2);
  }

  const violations = [];
  for (const page of SENSITIVE_PAGES) {
    const filePath = path.join(OUT_DIR, page.file);
    if (!fs.existsSync(filePath)) {
      violations.push({
        route: page.route,
        file: page.file,
        id: "missing-page",
        match: "expected route HTML is missing",
      });
      continue;
    }

    const text = stripHtml(fs.readFileSync(filePath, "utf8"));
    const normalizedText = text.toLowerCase();
    for (const rule of FORBIDDEN_COPY) {
      const matchIndex = rule.terms
        .map((term) => normalizedText.indexOf(term))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
      if (matchIndex === undefined) continue;
      violations.push({
        route: page.route,
        file: page.file,
        id: rule.id,
        match: preview(text, matchIndex),
      });
    }
  }

  if (violations.length === 0) {
    console.log(`OK: ${SENSITIVE_PAGES.length} classifier-sensitive pages avoid wallet-drainer and browser-warning copy.`);
    return;
  }

  console.error("");
  console.error("✗ Classifier-sensitive copy detected:");
  console.error("");
  for (const violation of violations) {
    console.error(`  ${violation.route} (${violation.file})`);
    console.error(`    [${violation.id}] ${violation.match}`);
  }
  console.error("");
  console.error("These pages sit near API keys, funding addresses, or bot onboarding.");
  console.error("Avoid wallet-drainer, token-claim, and browser-warning language on them.");
  process.exit(1);
}

main();
