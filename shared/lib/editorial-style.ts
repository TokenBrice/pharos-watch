/**
 * Runtime-neutral access to the Pharos editorial style policy.
 *
 * `docs/editorial-style.md` is the authored authority; its fenced policy block
 * is compiled into `./editorial-style.generated.ts`. This facade is the only
 * hand-written half: it turns that data into prompt text and scan findings so a
 * banned phrase and the prompt line that forbids it can never disagree.
 *
 * Deliberately free of Node, React, and Worker globals: the Worker imports it
 * through `@shared/lib/editorial-style` while root TypeScript type-checks it.
 * Corpus registries, extractors, and baselines live under `scripts/lib/` and
 * must never be imported from here, so nothing pulls CI plumbing into a bundle.
 */
import { EDITORIAL_POLICY, EDITORIAL_STYLE_HASH, EDITORIAL_STYLE_VERSION } from "./editorial-style.generated";

export { EDITORIAL_STYLE_HASH, EDITORIAL_STYLE_VERSION };

export type EditorialSeverity = "hard" | "advisory" | "off";
export type EditorialRegisterGroup = "editorial" | "technical" | "product";

export interface EditorialPatternSpec {
  readonly source: string;
  readonly flags: string;
}

export interface EditorialRuleSpec {
  readonly id: string;
  readonly promptLabel: string;
  readonly patterns: readonly EditorialPatternSpec[];
  readonly severity: { readonly default: EditorialSeverity; readonly byRegister?: Readonly<Record<string, EditorialSeverity>> };
  readonly closerOnly?: boolean;
  readonly exceptions?: readonly string[];
  readonly replacementAdvice?: string;
  readonly introducedIn: string;
}

export interface EditorialRegisterSpec {
  readonly id: string;
  readonly label: string;
  readonly group: EditorialRegisterGroup;
  readonly promptLine: string;
}

export interface EditorialPolicy {
  readonly version: string;
  readonly oneLineDirective: string;
  readonly registers: readonly EditorialRegisterSpec[];
  readonly rules: readonly EditorialRuleSpec[];
}

export interface EditorialScanContext {
  /** Register id from the policy; unknown ids throw rather than silently pass. */
  readonly register: string;
  /** Field name for diagnostics and retry instructions ("text", "extended"). */
  readonly field?: string;
  /**
   * Who wrote the string. Only `pharos` prose is governed; quoted sources and
   * user submissions are out of scope and scan clean by construction.
   */
  readonly ownership?: "pharos" | "quoted" | "user";
  /** Exception tokens the caller can prove, e.g. `literal-cemetery`. */
  readonly exemptions?: readonly string[];
}

export interface EditorialFinding {
  readonly ruleId: string;
  readonly severity: Exclude<EditorialSeverity, "off">;
  readonly promptLabel: string;
  readonly field?: string;
  readonly excerpt: string;
  readonly index: number;
  readonly advice?: string;
}

const REGISTERS: Readonly<Record<string, EditorialRegisterSpec>> = Object.fromEntries(
  EDITORIAL_POLICY.registers.map((register) => [register.id, register]),
);

/**
 * Compiled patterns are cached per rule: the digest scanner runs every rule
 * over three fields per edition, and the corpus gate runs them over thousands
 * of records, so recompiling on each call is wasted work.
 */
const COMPILED = new Map<string, RegExp[]>();

function patternsFor(rule: EditorialRuleSpec): RegExp[] {
  const cached = COMPILED.get(rule.id);
  if (cached) return cached;
  const compiled = rule.patterns.map((pattern) => new RegExp(pattern.source, pattern.flags));
  COMPILED.set(rule.id, compiled);
  return compiled;
}

export function editorialRegister(id: string): EditorialRegisterSpec {
  const register = REGISTERS[id];
  if (!register) {
    throw new Error(`[editorial-style] Unknown register "${id}". Registers: ${Object.keys(REGISTERS).join(", ")}.`);
  }
  return register;
}

export function severityFor(rule: EditorialRuleSpec, register: string): EditorialSeverity {
  return rule.severity.byRegister?.[register] ?? rule.severity.default;
}

/**
 * Closer-scoped rules judge only the terminal sentence: "worth watching" is a
 * dead closer but a legitimate mid-paragraph clause. The haystack is the last
 * sentence of the last non-empty paragraph, matching the digest guard's
 * long-standing behaviour.
 */
function closerHaystack(text: string): { text: string; offset: number } {
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim().length > 0);
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? "";
  const paragraphOffset = text.lastIndexOf(lastParagraph);
  const sentences = lastParagraph.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
  const lastSentence = sentences[sentences.length - 1] ?? lastParagraph;
  const sentenceOffset = lastParagraph.lastIndexOf(lastSentence);
  return { text: lastSentence, offset: (paragraphOffset < 0 ? 0 : paragraphOffset) + (sentenceOffset < 0 ? 0 : sentenceOffset) };
}

export function scanEditorialText(text: string, context: EditorialScanContext): EditorialFinding[] {
  const register = editorialRegister(context.register);
  if (context.ownership === "quoted" || context.ownership === "user") return [];
  if (text.length === 0) return [];

  const findings: EditorialFinding[] = [];
  for (const rule of EDITORIAL_POLICY.rules) {
    const severity = severityFor(rule, register.id);
    if (severity === "off") continue;
    if (context.exemptions?.some((exemption) => rule.exceptions?.includes(exemption))) continue;

    const haystack = rule.closerOnly ? closerHaystack(text) : { text, offset: 0 };
    if (haystack.text.length === 0) continue;

    for (const pattern of patternsFor(rule)) {
      for (const match of haystack.text.matchAll(pattern)) {
        const at = haystack.offset + (match.index ?? 0);
        findings.push({
          ruleId: rule.id,
          severity,
          promptLabel: rule.promptLabel,
          field: context.field,
          excerpt: match[0],
          index: at,
          advice: rule.replacementAdvice,
        });
      }
    }
  }
  return findings.sort((left, right) => left.index - right.index || left.ruleId.localeCompare(right.ruleId));
}

/**
 * Renders the prompt preamble for a surface. Prompt copy is derived from the
 * same rule records the scanner enforces, which is the property that keeps a
 * model's instructions and its gate in sync.
 */
export function buildEditorialPrompt(registerId: string): string {
  const register = editorialRegister(registerId);
  const blocking: string[] = [];
  const reviewed: string[] = [];
  for (const rule of EDITORIAL_POLICY.rules) {
    const severity = severityFor(rule, register.id);
    if (severity === "hard") blocking.push(rule.promptLabel);
    else if (severity === "advisory") reviewed.push(rule.promptLabel);
  }

  const lines = [EDITORIAL_POLICY.oneLineDirective, "", `REGISTER: ${register.label}. ${register.promptLine}`];
  if (blocking.length > 0) {
    lines.push("", "NEVER (a violation blocks publication):", ...blocking.map((label) => `- ${label}`));
  }
  if (reviewed.length > 0) {
    lines.push("", "AVOID (reviewed, not blocking):", ...reviewed.map((label) => `- ${label}`));
  }
  return lines.join("\n");
}

export function formatEditorialFindings(findings: readonly EditorialFinding[]): string {
  return findings
    .map((finding) => {
      const where = finding.field ? `${finding.field}: ` : "";
      const advice = finding.advice ? ` ${finding.advice}` : "";
      return `- [${finding.ruleId}] ${where}"${finding.excerpt}" at ${finding.index}.${advice}`;
    })
    .join("\n");
}

export function hasBlockingEditorialFindings(findings: readonly EditorialFinding[]): boolean {
  return findings.some((finding) => finding.severity === "hard");
}

export const EDITORIAL_ONE_LINE_DIRECTIVE = EDITORIAL_POLICY.oneLineDirective;
export const EDITORIAL_REGISTER_IDS: readonly string[] = EDITORIAL_POLICY.registers.map((register) => register.id);
