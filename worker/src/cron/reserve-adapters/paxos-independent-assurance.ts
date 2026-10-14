import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { sha256Hex } from "../../lib/hash";
import { fetchIndependentAssuranceReserves } from "./independent-assurance";
import { readHtmlAttribute } from "./helpers";
import { fetchBinaryResponseWithRetry, fetchTextResponseWithRetry } from "./request";
import type { AdapterContext, IndependentAssuranceProfile } from "./types";

type PaxosProduct = LiveReserveAdapterParamsByKey["paxos-independent-assurance"]["product"];

/**
 * Machine-readable discovery failure codes. Every rejection is fail-closed: the
 * adapter never falls back to a stale module, an unreviewed selection, or a
 * partially parsed route table.
 */
export type PaxosDiscoveryFailureCode =
  | "main-module-missing"
  | "main-module-ambiguous"
  | "main-module-origin-drifted"
  | "main-module-response-drifted"
  | "route-table-unrecognized"
  | "route-binding-missing"
  | "route-binding-ambiguous"
  | "page-module-identity-drifted"
  | "page-module-response-drifted"
  | "page-module-bytes-drifted"
  | "report-binding-missing";

export class PaxosDiscoveryError extends Error {
  readonly code: PaxosDiscoveryFailureCode;

  constructor(code: PaxosDiscoveryFailureCode, detail: string) {
    super(`paxos-independent-assurance: ${code}: ${detail}`);
    this.name = "PaxosDiscoveryError";
    this.code = code;
  }
}

/**
 * Discover the volatile main-module filename each run and pin the complete
 * normalized product page. Leading imports preserve module basenames and ordered
 * locals, normalizing only chunk hashes/export labels and the final source-map
 * URL. Dynamic page imports reject; every remaining body byte stays pinned.
 * Body changes require review; exact PDF identity remains separately pinned.
 */
export interface PaxosProductBinding {
  /** Reviewed Framer site origin serving the main and page modules. */
  siteOrigin: string;
  /** Official route the index page is served at, e.g. `/pyusd-transparency`. */
  routePath: string;
  /** Reviewed Framer page identifier; not a guarantee about the fetched body. */
  pageModuleId: string;
  pageNormalizedSha256: string;
  pageNormalizedByteLength: number;
}

function paxosReportDate(product: PaxosProduct, href: string): string | null {
  const manifest = getIndependentAssuranceManifest(product);
  return href === manifest.reportUrl ? manifest.reportDate : null;
}

const PAXOS_FRAMER_SITE_ORIGIN = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";

// Normalized page pins derived from the verified October 14 captures.
// The full September 30 and October 13 PAXG captures normalize identically.
// Only reviewed products are registered; absent products fail closed.
const PAXOS_PRODUCTS: Partial<Record<PaxosProduct, { binding: PaxosProductBinding; profile: IndependentAssuranceProfile }>> = {
  PAXG: {
    // Reviewed 2026-09-25: official route and August 31 KPMG report selection
    // (Exhibit A adds a 5-token Robinhood column beside Ethereum and Solana).
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/paxg-transparency",
      pageModuleId: "9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU",
      pageNormalizedSha256: "7fb418d7c26b71b29131c8b0b2a876103900a2da7ecd8bd2d01a7b6d9e3e1deb",
      pageNormalizedByteLength: 444412,
    },
    profile: {
      adapterName: "paxos-independent-assurance",
      product: "PAXG",
      profile: "paxg-v1",
      requiredAssetCodes: ["allocated-gold"],
      classifications: {
        "allocated-gold": {
          name: "Physical gold bars (London Good Delivery, LBMA-accredited London vaults)",
          risk: "very-low",
          assetClass: "commodity-allocated",
          issuerOrObligor: "Paxos Trust Company, N.A. and allocated gold held in LBMA-accredited London vaults",
          riskFactors: ["custody", "legal", "liquidity", "market", "concentration"],
          liquidityHorizon: "unknown",
        },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("PAXG").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("PAXG", href),
    },
  },
  PYUSD: {
    // Reviewed August 2026 year-specific open variants on 2026-09-25.
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/pyusd-transparency",
      pageModuleId: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM",
      pageNormalizedSha256: "97694985e762b6236728a70cc449ecfd6c1c5b05fa52db1754567b95fc2d5658",
      pageNormalizedByteLength: 418610,
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "PYUSD", profile: "pyusd-v1",
      requiredAssetCodes: ["cash", "reverse-repo", "treasury-bills"],
      classifications: {
        cash: { name: "USD bank deposits held for token holders", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed United States commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "reverse-repo": { name: "Overnight U.S. Treasury reverse repurchase agreements", risk: "very-low", assetClass: "repo", issuerOrObligor: "Undisclosed United States banks; U.S. Treasury collateral", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
        "treasury-bills": { name: "U.S. Treasury bills (remaining maturity at most three months)", risk: "very-low", assetClass: "treasury-bill", issuerOrObligor: "United States Treasury", riskFactors: ["duration", "market", "custody"], liquidityHorizon: "over-seven-days" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("PYUSD").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("PYUSD", href),
    },
  },
  USDG: {
    // Reviewed 2026-09-30: August 2026 y397A2bek / MyKpGtOFv / LghKhDIKj
    // overrides all select Xn1U..., examined August 6 and 31, signed September 25.
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/usdg-transparency",
      pageModuleId: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo",
      pageNormalizedSha256: "49a4c2b6ab96ff150a299f6a5b24bc79a1528f6856f786ccdb47c5f22998556e",
      pageNormalizedByteLength: 246842,
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "USDG", profile: "usdg-v1",
      requiredAssetCodes: ["cash", "government-mmf", "treasury-bills"],
      classifications: {
        cash: { name: "USD bank deposits (PDS Singapore and PIE Luxembourg)", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed Singapore and Luxembourg commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "government-mmf": { name: "Government money market funds (PDS and PIE)", risk: "very-low", assetClass: "money-market-fund", issuerOrObligor: "Government money market funds holding U.S. government obligations and reverse repos", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
        "treasury-bills": { name: "U.S. Treasury bills (remaining maturity at most three months)", risk: "very-low", assetClass: "treasury-bill", issuerOrObligor: "United States Treasury", riskFactors: ["duration", "market", "custody"], liquidityHorizon: "over-seven-days" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("USDG").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("USDG", href),
    },
  },
  USDP: {
    // Reviewed August 2026 year-specific open variants on 2026-09-25.
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/usdp-transparency",
      pageModuleId: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM",
      pageNormalizedSha256: "b976099d443bcfb4ab0662997d185e92a928adbaf6d83a16a0f96a38476926b1",
      pageNormalizedByteLength: 669863,
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "USDP", profile: "usdp-v1",
      requiredAssetCodes: ["cash", "reverse-repo"],
      classifications: {
        cash: { name: "USD bank deposits held for token holders", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed United States commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "reverse-repo": { name: "Overnight U.S. Treasury reverse repurchase agreements", risk: "very-low", assetClass: "repo", issuerOrObligor: "Undisclosed United States banks; U.S. Treasury collateral", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("USDP").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("USDP", href),
    },
  },
};

const PAGE_MODULE_SPECIFIER_PATTERN = /^\.\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.mjs$/;

interface MainToken {
  kind: "identifier" | "literal" | "punctuation";
  value: string;
  plain: boolean;
  start: number;
  end: number;
}

const JS_LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** Linear lexical pass. Comments and literal contents never become route code. */
function tokenizePaxosModule(source: string, failureCode: "route-table-unrecognized" | "page-module-bytes-drifted") {
  const tokens: MainToken[] = [];
  const comments: { start: number; end: number }[] = [];
  const controlParentheses: boolean[] = [];
  let canDivide = false;
  let closedBrace = false;
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (/\s/.test(character)) { index++; continue; }
    if (source.startsWith("//", index)) {
      const start = index;
      index += 2;
      while (index < source.length && !JS_LINE_TERMINATOR.test(source[index]!)) index++;
      comments.push({ start, end: index });
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new PaxosDiscoveryError(failureCode, "unterminated module comment");
      comments.push({ start: index, end: end + 2 });
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const start = index++;
      let plain = true;
      // Template interpolations, including nested templates/strings, are opaque.
      const modes: ({ quote: string } | { braces: number })[] = [{ quote: character }];
      while (modes.length && index < source.length) {
        const mode = modes[modes.length - 1]!;
        const next = source[index]!;
        if ("quote" in mode) {
          if (next === "\\") { plain = false; index += 2; continue; }
          if (next === mode.quote) { modes.pop(); index++; continue; }
          if (mode.quote !== "`" && JS_LINE_TERMINATOR.test(next)) {
            throw new PaxosDiscoveryError(failureCode, "invalid module string");
          }
          if (mode.quote === "`" && source.startsWith("${", index)) {
            plain = false;
            modes.push({ braces: 1 });
            index += 2;
            continue;
          }
          index++;
        } else if (source.startsWith("//", index)) {
          const start = index;
          index += 2;
          while (index < source.length && !JS_LINE_TERMINATOR.test(source[index]!)) index++;
          comments.push({ start, end: index });
        } else if (source.startsWith("/*", index)) {
          const end = source.indexOf("*/", index + 2);
          if (end === -1) throw new PaxosDiscoveryError(failureCode, "unterminated template comment");
          comments.push({ start: index, end: end + 2 });
          index = end + 2;
        } else if (next === '"' || next === "'" || next === "`") {
          modes.push({ quote: next });
          index++;
        } else if (next === "{") { mode.braces++; index++; }
        else if (next === "}") {
          if (--mode.braces === 0) modes.pop();
          index++;
        } else if (next === "/") {
          // Regex/division grammar inside interpolation is not needed to bind
          // routes; fail closed rather than mis-tokenizing its braces/quotes.
          throw new PaxosDiscoveryError(failureCode, "unsupported template expression");
        } else index++;
      }
      if (modes.length) throw new PaxosDiscoveryError(failureCode, "unterminated module literal");
      tokens.push({ kind: "literal", value: plain ? source.slice(start + 1, index - 1) : "", plain, start, end: index });
      canDivide = true;
      closedBrace = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index++;
      while (index < source.length && /[\w$]/.test(source[index]!)) index++;
      tokens.push({ kind: "identifier", value: source.slice(start, index), plain: true, start, end: index });
      canDivide = !/^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do|new)$/.test(source.slice(start, index));
      closedBrace = false;
      continue;
    }
    if (character === "/" && !canDivide) {
      if (closedBrace) throw new PaxosDiscoveryError(failureCode, "ambiguous slash after a closing brace");
      const start = index++;
      let inClass = false;
      let closed = false;
      while (index < source.length) {
        const next = source[index++]!;
        if (JS_LINE_TERMINATOR.test(next)) break;
        if (next === "\\") { index++; continue; }
        if (next === "[") inClass = true;
        else if (next === "]") inClass = false;
        else if (next === "/" && !inClass) { closed = true; break; }
      }
      if (!closed) throw new PaxosDiscoveryError(failureCode, "unterminated module regular expression");
      while (index < source.length && /[A-Za-z]/.test(source[index]!)) index++;
      tokens.push({ kind: "literal", value: "", plain: false, start, end: index });
      canDivide = true;
      continue;
    }
    const previous = tokens[tokens.length - 1];
    if (character === "(") {
      controlParentheses.push(previous?.kind === "identifier" &&
        /^(?:if|while|for|with|switch|catch)$/.test(previous.value) && tokens[tokens.length - 2]?.value !== ".");
      canDivide = false;
    } else if (character === ")") {
      canDivide = !controlParentheses.pop();
    } else {
      canDivide = character === "]" || /[0-9]/.test(character);
    }
    closedBrace = character === "}";
    tokens.push({ kind: "punctuation", value: character, plain: true, start: index, end: index + 1 });
    index++;
  }
  return { tokens, comments };
}

interface RouteFrame {
  parent: RouteFrame | null;
  start: number;
  end: number;
  assignedName: string | null;
  wrapper: string | null;
  imports: (string | null)[];
  pages: (string | null)[];
  paths: string[];
  computedKey: boolean;
}

function memberRootBefore(tokens: MainToken[], end: number): string | null {
  while (end >= 0) {
    if (tokens[end]?.value === "]") {
      let depth = 1;
      while (--end >= 0 && depth) {
        if (tokens[end]?.value === "]") depth++;
        else if (tokens[end]?.value === "[") depth--;
      }
      if (depth) return null;
      continue;
    }
    if (tokens[end]?.kind !== "identifier") return null;
    if (tokens[end - 1]?.value === ".") { end -= 2; continue; }
    return tokens[end]!.value;
  }
  return null;
}

function discoverPaxosRouteImport(source: string, routePath: string): string {
  const { tokens } = tokenizePaxosModule(source, "route-table-unrecognized");
  const frames: RouteFrame[] = [];
  const stack: RouteFrame[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === "punctuation" && token.value === "{") {
      const frame: RouteFrame = {
        parent: stack[stack.length - 1] ?? null, start: index, end: -1,
        assignedName: tokens[index - 1]?.value === "=" && tokens[index - 2]?.kind === "identifier"
          ? tokens[index - 2]!.value : null,
        wrapper: null, imports: [], pages: [], paths: [], computedKey: false,
      };
      frames.push(frame);
      stack.push(frame);
      continue;
    }
    if (token.kind === "punctuation" && token.value === "}") {
      const frame = stack.pop();
      if (!frame) throw new PaxosDiscoveryError("route-table-unrecognized", "unbalanced main-module objects");
      frame.end = index;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (!frame) continue;
    const previous = tokens[index - 1];
    const propertyPosition = previous?.kind === "punctuation" && (previous.value === "{" || previous.value === ",");
    if (propertyPosition && token.kind === "punctuation" && token.value === "[") frame.computedKey = true;
    if (propertyPosition && token.value === "page" && token.plain) {
      const wrapper = tokens[index + 2];
      const specifier = tokens[index + 10];
      const shape = [":", null, "(", "(", ")", "=", ">", "import", "(", null, ")", ")"];
      const complete = shape.every((expected, offset) => expected === null || tokens[index + offset + 1]?.value === expected) &&
        wrapper?.kind === "identifier" && tokens[index + 8]?.kind === "identifier" &&
        specifier?.kind === "literal" && specifier.plain &&
        (tokens[index + 13]?.value === "," || tokens[index + 13]?.value === "}");
      frame.pages.push(complete ? specifier.value : null);
      frame.wrapper = complete ? wrapper.value : null;
    }
    if (propertyPosition && token.value === "path" && token.plain &&
      (token.kind === "identifier" || token.kind === "literal")) {
      const value = tokens[index + 2];
      const end = tokens[index + 3];
      if (tokens[index + 1]?.kind !== "punctuation" || tokens[index + 1]?.value !== ":" || value?.kind !== "literal" || !value.plain ||
        end?.kind !== "punctuation" || (end.value !== "," && end.value !== "}")) {
        throw new PaxosDiscoveryError("route-table-unrecognized", "route path is not a complete plain literal");
      }
      frame.paths.push(value.value);
    }
    if (token.kind === "identifier" && token.value === "import" && previous?.value !== "." && tokens[index + 1]?.value === "(") {
      const value = tokens[index + 2];
      frame.imports.push(value?.kind === "literal" && value.plain && tokens[index + 3]?.value === ")"
        ? value.value : null);
    }
  }
  if (stack.length) throw new PaxosDiscoveryError("route-table-unrecognized", "unbalanced main-module objects");
  const bindings: RouteFrame[] = [];
  for (const frame of frames) {
    if (frame.computedKey && frame.imports.length) throw new PaxosDiscoveryError("route-table-unrecognized", "computed route property");
    if (!frame.paths.length) continue;
    if (frame.paths.length !== 1 || frame.imports.length !== 1 || frame.imports[0] === null ||
      frame.pages.length !== 1 || frame.pages[0] !== frame.imports[0]) {
      throw new PaxosDiscoveryError("route-table-unrecognized", "route must bind exactly one literal page import");
    }
    if (frame.paths[0] === routePath) bindings.push(frame);
  }
  if (!bindings.length) throw new PaxosDiscoveryError("route-binding-missing", `official route ${routePath} is absent`);
  if (bindings.length !== 1) throw new PaxosDiscoveryError("route-binding-ambiguous", `official route ${routePath} has ${bindings.length} active bindings`);
  const product = bindings[0]!;
  const table = product.parent;
  const peers = frames.filter((frame) => frame.parent === table && frame.paths.length);
  if (!table?.assignedName || peers.length < 2 || peers.some((frame) => frame.wrapper !== product.wrapper)) {
    throw new PaxosDiscoveryError("route-table-unrecognized", "product route must use the table's common lazy helper");
  }
  for (let index = table.start; index <= table.end; index++) {
    if (tokens[index]?.kind === "punctuation" && tokens[index]?.value === "." &&
      tokens[index + 1]?.value === "." && tokens[index + 2]?.value === ".") {
      throw new PaxosDiscoveryError("route-table-unrecognized", "spread in product route table");
    }
  }
  for (let index = table.end + 1; index < tokens.length; index++) {
    let assignment: number | null = null;
    if (tokens[index]?.value === "." && tokens[index + 1]?.kind === "identifier" && tokens[index + 1]?.value === "page") {
      assignment = index + 2;
    } else if (tokens[index]?.value === "[" && tokens[index + 1]?.kind === "literal" &&
      tokens[index + 1]?.plain && tokens[index + 1]?.value === "page" && tokens[index + 2]?.value === "]") {
      assignment = index + 3;
    }
    if (assignment === null) continue;
    const operator = tokens.slice(assignment, assignment + 3).map((token) => token.value).join("");
    if (/^(?:=(?!=|>)|[+\-*/%&|^]=|(?:\?\?|\|\||&&)=)/.test(operator) &&
      memberRootBefore(tokens, index - 1) === table.assignedName) {
      throw new PaxosDiscoveryError("route-table-unrecognized", "later page assignment to product route table");
    }
  }
  return product.imports[0]!;
}

function readLeadingStaticImport(tokens: MainToken[], start: number): { locals: string[]; specifier: string; end: number } {
  const locals: string[] = [];
  let index = start + 1;
  if (tokens[index]?.kind !== "literal") {
    if (tokens[index]?.kind === "identifier") {
      locals.push(tokens[index++]!.value);
      if (tokens[index]?.value === ",") index++;
    }
    if (tokens[index]?.value === "*") {
      if (tokens[index + 1]?.value !== "as" || tokens[index + 2]?.kind !== "identifier") {
        throw new PaxosDiscoveryError("page-module-bytes-drifted", "unsupported namespace import");
      }
      locals.push(tokens[index + 2]!.value);
      index += 3;
    } else if (tokens[index]?.value === "{") {
      index++;
      while (tokens[index]?.value !== "}") {
        const imported = tokens[index++];
        if (!imported || (imported.kind !== "identifier" && imported.kind !== "literal")) {
          throw new PaxosDiscoveryError("page-module-bytes-drifted", "unsupported named import");
        }
        if (tokens[index]?.value === "as") {
          index++;
          if (tokens[index]?.kind !== "identifier") throw new PaxosDiscoveryError("page-module-bytes-drifted", "invalid import local");
          locals.push(tokens[index++]!.value);
        } else {
          if (imported.kind !== "identifier") throw new PaxosDiscoveryError("page-module-bytes-drifted", "missing import local");
          locals.push(imported.value);
        }
        if (tokens[index]?.value === ",") index++;
        else if (tokens[index]?.value !== "}") throw new PaxosDiscoveryError("page-module-bytes-drifted", "invalid named import delimiter");
      }
      index++;
    }
    if (tokens[index]?.kind !== "identifier" || tokens[index]?.value !== "from") {
      throw new PaxosDiscoveryError("page-module-bytes-drifted", "missing static import source");
    }
    index++;
  }
  if (tokens[index]?.kind !== "literal" || !tokens[index]?.plain || tokens[index + 1]?.value !== ";") {
    throw new PaxosDiscoveryError("page-module-bytes-drifted", "static import source is not a complete literal");
  }
  const specifier = tokens[index]!.value.replace(/^(\.\/[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.mjs$/, "$1.<H>.mjs");
  return { locals, specifier, end: index + 1 };
}

/**
 * Pin the complete body and import module basenames/local bindings. Only
 * relative specifier hash segments, mangled imported export names and the exact
 * final source-map URL are normalized. Dynamic page imports are unsupported;
 * no report URL, label, text or other body change is normalized.
 */
export function normalizePaxosPageModule(source: string): string {
  const { tokens, comments } = tokenizePaxosModule(source, "page-module-bytes-drifted");
  const replacements: { start: number; end: number; value: string }[] = [];
  const leadingImports = new Set<number>();
  let prefix = 0;
  while (tokens[prefix]?.kind === "identifier" && tokens[prefix]?.value === "import" &&
    tokens[prefix + 1]?.value !== "(" && tokens[prefix + 1]?.value !== ".") {
    const declaration = readLeadingStaticImport(tokens, prefix);
    leadingImports.add(prefix);
    replacements.push({
      start: tokens[prefix]!.start, end: tokens[declaration.end]!.end,
      value: `import{${declaration.locals.join(",")}}from${JSON.stringify(declaration.specifier)};`,
    });
    prefix = declaration.end + 1;
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "identifier" || token.value !== "import" || tokens[index - 1]?.value === ".") continue;
    if (tokens[index + 1]?.value === "(") {
      throw new PaxosDiscoveryError("page-module-bytes-drifted", "dynamic import in product page module");
    } else if (tokens[index + 1]?.value !== "." && !leadingImports.has(index)) {
      throw new PaxosDiscoveryError("page-module-bytes-drifted", "static import is not a leading declaration");
    }
  }
  const sourceMaps = comments.filter((comment) => source.slice(comment.start, comment.end).includes("sourceMappingURL"));
  if (sourceMaps.length > 1) throw new PaxosDiscoveryError("page-module-bytes-drifted", "multiple source-map comments");
  if (sourceMaps.length === 1) {
    const comment = sourceMaps[0]!;
    const value = source.slice(comment.start, comment.end);
    if (!/^\/\/# sourceMappingURL=[A-Za-z0-9_.-]+\.mjs\.map$/.test(value) ||
      !/^(?:\r\n|[\n\r\u2028\u2029])?$/.test(source.slice(comment.end))) {
      throw new PaxosDiscoveryError("page-module-bytes-drifted", "source-map comment is not the exact final line");
    }
    replacements.push({ start: comment.start + "//# sourceMappingURL=".length, end: comment.end, value: "__paxos_page__.mjs.map" });
  }
  replacements.sort((left, right) => left.start - right.start);
  let offset = 0;
  const parts: string[] = [];
  for (const replacement of replacements) {
    parts.push(source.slice(offset, replacement.start), replacement.value);
    offset = replacement.end;
  }
  parts.push(source.slice(offset));
  return parts.join("");
}

/**
 * Resolve the sole active literal route without executing site code, then admit
 * only exact reviewed page-module bytes. A new report or any other page edit
 * requires review; main-module filename churn alone does not.
 */
export async function verifyPaxosDiscovery(
  html: string,
  binding: PaxosProductBinding,
  reportUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)]
    .map(([tag]) => readHtmlAttribute(tag, "src"))
    .filter((src) => src?.includes("script_main."));
  if (scripts.length === 0) {
    throw new PaxosDiscoveryError("main-module-missing", "official index references no script_main module");
  }
  if (scripts.length > 1) {
    throw new PaxosDiscoveryError(
      "main-module-ambiguous",
      `official index references ${scripts.length} script_main modules: ${[...new Set(scripts)].join(", ")}`,
    );
  }
  let mainUrl: URL;
  try {
    mainUrl = new URL(scripts[0]!);
  } catch {
    throw new PaxosDiscoveryError("main-module-origin-drifted", `script src ${scripts[0]} is not a valid absolute URL`);
  }
  if (mainUrl.origin !== new URL(binding.siteOrigin).origin) {
    throw new PaxosDiscoveryError(
      "main-module-origin-drifted",
      `main module ${mainUrl.href} is not served by the reviewed site ${binding.siteOrigin}`,
    );
  }

  const mainResponse = await fetchTextResponseWithRetry(mainUrl.href, signal, 10_000, ctx, {
    maxRetries: 0,
    maxResponseBytes: 1024 * 1024,
  });
  if (mainResponse.finalUrl !== mainUrl.href) {
    throw new PaxosDiscoveryError("main-module-response-drifted", `main module redirected to ${mainResponse.finalUrl}`);
  }

  const specifier = discoverPaxosRouteImport(mainResponse.body, binding.routePath);
  const pageModuleMatch = PAGE_MODULE_SPECIFIER_PATTERN.exec(specifier);
  if (!pageModuleMatch) {
    throw new PaxosDiscoveryError(
      "route-table-unrecognized",
      `page import ${specifier} for ${binding.routePath} does not use the reviewed identity.chunk shape`,
    );
  }
  if (pageModuleMatch[1] !== binding.pageModuleId) {
    throw new PaxosDiscoveryError(
      "page-module-identity-drifted",
      `route ${binding.routePath} now serves ${pageModuleMatch[1]}.${pageModuleMatch[2]}.mjs; the reviewed page module ${binding.pageModuleId} was re-published, so review the new report selection`,
    );
  }

  const pageModuleUrl = new URL(specifier, mainUrl).href;
  const pageResponse = await fetchBinaryResponseWithRetry(pageModuleUrl, signal, 10_000, ctx, {
    maxRetries: 0,
    // Product page modules embed the full month archive across locales and run
    // 250-670 KB today (USDP is the largest), so cap above that headroom.
    maxResponseBytes: 2 * 1024 * 1024,
  });
  if (pageResponse.finalUrl !== pageModuleUrl) {
    throw new PaxosDiscoveryError("page-module-response-drifted", `page module redirected to ${pageResponse.finalUrl}`);
  }
  let page: string;
  try {
    page = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pageResponse.body);
  } catch {
    throw new PaxosDiscoveryError("page-module-bytes-drifted", "product page is not valid UTF-8");
  }
  const normalized = new TextEncoder().encode(normalizePaxosPageModule(page));
  if (normalized.byteLength !== binding.pageNormalizedByteLength ||
    await sha256Hex(normalized) !== binding.pageNormalizedSha256) {
    throw new PaxosDiscoveryError("page-module-bytes-drifted", "normalized product page differs from the reviewed report-selection capture");
  }
  if (!page.includes(`file:\`${reportUrl}\``)) {
    throw new PaxosDiscoveryError("report-binding-missing", `reviewed report ${reportUrl} is absent from the pinned page`);
  }
  return page;
}


export async function fetchPaxosIndependentAssuranceReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) {
  const { product } = parseLiveReserveAdapterParams("paxos-independent-assurance", config.params);
  const entry = PAXOS_PRODUCTS[product];
  if (!entry) throw new Error(`paxos-independent-assurance: no reviewed discovery/profile for ${product}`);
  const manifest = getIndependentAssuranceManifest(product);
  if (new URL(manifest.officialIndexUrl).pathname !== entry.binding.routePath) {
    throw new Error(
      `paxos-independent-assurance: manifest index ${manifest.officialIndexUrl} does not match reviewed route ${entry.binding.routePath}`,
    );
  }
  const profile: IndependentAssuranceProfile = {
    ...entry.profile,
    verifyIndexJson: async (html, reviewed, requestSignal, context) => {
      await verifyPaxosDiscovery(html, entry.binding, reviewed.reportUrl, requestSignal, context);
    },
  };
  return fetchIndependentAssuranceReserves(coin, config, signal, profile, {
    product,
    profile: profile.profile,
    indexHost: new URL(manifest.officialIndexUrl).hostname,
    reportHosts: [new URL(entry.binding.siteOrigin).hostname],
  }, ctx);
}
