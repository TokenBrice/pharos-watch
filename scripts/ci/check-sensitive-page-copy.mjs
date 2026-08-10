#!/usr/bin/env node
/**
 * Keeps wallet-drainer, token-claim, and browser-warning phrasing off the three
 * classifier-sensitive public surfaces: `/api/` (issues API keys), `/funding/`
 * (publishes wallet addresses), and `/pharoswatchbot/` (bot onboarding). Those
 * pages already carry the signals a phishing classifier looks for; drainer copy
 * next to them is what turns a benign page into a flagged one.
 *
 * Deliberately narrow. The predecessor scanned rendered `out/` HTML and so
 * needed a build; this reads the pages' own source, which is where the copy is
 * authored, and skips `//` comments so engineering notes stay writable. Docs,
 * methodology, and incident runbooks are out of scope on purpose — they discuss
 * these terms legitimately.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { collectSourceFilesUnderRoot, formatScannedOk, runAsCli } from "../lib/source-files.mjs";

export const SENSITIVE_COPY_ROOTS = [
  "src/app/api",
  "src/app/funding",
  "src/app/pharoswatchbot",
  "src/components/funding",
  "src/components/api-key-request-fields.tsx",
  "src/components/api-key-request-form.tsx",
  "src/components/api-key-request-reveal.tsx",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

/** Multi-word by design: code identifiers are camelCase, so these only match prose. */
export const FORBIDDEN_COPY = [
  { id: "seed-phrase", terms: ["seed phrase", "recovery phrase", "private key"] },
  { id: "connect-wallet", terms: ["connect wallet", "connect your wallet", "wallet connect"] },
  { id: "verify-wallet", terms: ["verify wallet", "verify your wallet", "validate wallet", "sync wallet"] },
  { id: "claim-or-airdrop", terms: ["claim tokens", "claim your tokens", "claim rewards", "airdrop"] },
  { id: "transaction-approval", terms: ["approve transaction", "approve this transaction", "sign message", "sign this message"] },
  { id: "browser-warning-copy", terms: ["dangerous site", "back to safety", "security warning", "fix your browser"] },
  { id: "urgency-pressure", terms: ["urgent action required", "act now to secure"] },
];

export function collectSensitiveCopyFindings(roots = SENSITIVE_COPY_ROOTS, cwd = process.cwd()) {
  const findings = [];

  for (const root of roots) {
    for (const file of collectSourceFilesUnderRoot(root, cwd, { extensions: SOURCE_EXTENSIONS })) {
      const rel = relative(cwd, file).replaceAll("\\", "/");
      const lines = readFileSync(file, "utf8").split(/\r?\n/g);
      lines.forEach((raw, index) => {
        const text = raw.trim();
        if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
        const haystack = text.toLowerCase();
        for (const rule of FORBIDDEN_COPY) {
          const term = rule.terms.find((candidate) => haystack.includes(candidate));
          if (term) findings.push({ file: rel, line: index + 1, id: rule.id, term, text });
        }
      });
    }
  }

  return findings;
}

export function checkSensitivePageCopy({
  roots = SENSITIVE_COPY_ROOTS,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const scanned = roots.reduce(
    (total, root) => total + collectSourceFilesUnderRoot(root, cwd, { extensions: SOURCE_EXTENSIONS }).length,
    0,
  );
  const findings = collectSensitiveCopyFindings(roots, cwd);
  if (findings.length === 0) {
    stdout.write(formatScannedOk("[sensitive-page-copy] Classifier-sensitive pages avoid drainer copy", scanned));
    return 0;
  }

  stderr.write("\n[sensitive-page-copy] Wallet-drainer or browser-warning copy detected:\n\n");
  for (const finding of findings) {
    stderr.write(`  ${finding.file}:${finding.line} [${finding.id}] "${finding.term}"\n    ${finding.text}\n`);
  }
  stderr.write("\nThese pages sit next to API keys, funding addresses, and bot onboarding.\n");
  stderr.write("Reword the copy; do not widen the phrase list to make this pass.\n");
  return 1;
}

runAsCli(import.meta.url, () => process.exit(checkSensitivePageCopy()));
