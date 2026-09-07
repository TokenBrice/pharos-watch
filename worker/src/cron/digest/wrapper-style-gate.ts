import { scanEditorialText, type EditorialFinding } from "@shared/lib/editorial-style";
import { escapeHtml } from "../../lib/telegram";

export interface DigestWrapperEditorialFinding {
  ruleId: string;
  field: "twitter" | "telegram";
  excerpt: string;
  originalSeverity: "hard" | "advisory";
}

const WRAPPER_FINDING_LIMIT = 8;
const WRAPPER_EXCERPT_LIMIT = 120;

function maskRange(value: string, start: number, end: number): string {
  if (start < 0 || end <= start) return value;
  return `${value.slice(0, start)}${" ".repeat(end - start)}${value.slice(end)}`;
}

function maskSegment(value: string, segment: string): string {
  if (!segment) return value;
  let masked = value;
  let at = masked.indexOf(segment);
  while (at >= 0) {
    masked = maskRange(masked, at, at + segment.length);
    at = masked.indexOf(segment, at + segment.length);
  }
  return masked;
}

function hardFindings(
  findings: readonly EditorialFinding[],
  field: "twitter" | "telegram",
): DigestWrapperEditorialFinding[] {
  return findings
    .filter((finding) => finding.severity === "hard")
    .slice(0, WRAPPER_FINDING_LIMIT)
    .map((finding) => ({
      ruleId: finding.ruleId,
      field,
      excerpt: finding.excerpt.slice(0, WRAPPER_EXCERPT_LIMIT),
      originalSeverity: finding.severity,
    }));
}

export function scanTwitterDigestWrapper(params: {
  rendered: string;
  title: string;
  editionNumber: number | null;
  mapHook: string | null;
}): DigestWrapperEditorialFinding[] {
  const editionTag = params.editionNumber ? ` (#${params.editionNumber})` : "";
  const titlePrefixLength = params.title ? params.title.length + editionTag.length + 2 : 0;
  const mapSuffixLength = params.mapHook ? params.mapHook.length + 2 : 0;
  let wrapperOnly = maskRange(params.rendered, 0, params.title.length);
  wrapperOnly = maskRange(
    wrapperOnly,
    titlePrefixLength,
    Math.max(titlePrefixLength, wrapperOnly.length - mapSuffixLength),
  );
  return hardFindings(
    scanEditorialText(wrapperOnly, { register: "delivery-wrapper", field: "twitter" }),
    "twitter",
  );
}

export function scanTelegramDigestWrapper(params: {
  rendered: string;
  modelTitle: string;
  modelExtended: string;
  cemeteryAppendixHtml: string | null;
}): DigestWrapperEditorialFinding[] {
  let wrapperOnly = maskSegment(params.rendered, escapeHtml(params.modelTitle));
  const renderedModelBody = escapeHtml(params.modelExtended).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  wrapperOnly = maskSegment(wrapperOnly, renderedModelBody);

  const cemeteryAppendix = params.cemeteryAppendixHtml ?? "";
  const ordinaryWrapper = maskSegment(wrapperOnly, cemeteryAppendix);
  const findings = scanEditorialText(ordinaryWrapper, {
    register: "delivery-wrapper",
    field: "telegram",
  });
  if (cemeteryAppendix) {
    findings.push(...scanEditorialText(cemeteryAppendix, {
      register: "delivery-wrapper",
      field: "telegram",
      exemptions: ["literal-cemetery"],
    }));
  }
  return hardFindings(findings, "telegram");
}
