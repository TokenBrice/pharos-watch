import { z } from "zod";
import type { SafetyScoreV9CardValidationInput } from "./safety-score-v9-public";

const V9PublicWitnessTextEntrySchema = z.union([
  z.string().min(1),
  z.tuple([z.number().int().nonnegative(), z.number().int().refine((length) => length !== 0), z.string()]),
]);
export type V9PublicWitnessTextEntry = z.output<typeof V9PublicWitnessTextEntrySchema>;
export const V9PublicWitnessTextTableSchema = z.array(V9PublicWitnessTextEntrySchema).min(1).describe(
  "Card-local witness texts, unique and sorted after resolution. Each entry is a literal string or [earlierEntryRef, sliceLengthUtf16, literalRemainder]. Positive lengths append the remainder to the earlier text prefix; negative lengths prepend it to the earlier text suffix. message, path, field, label, controlKey, posture, control-component key and plain-text cap/deployment/coverage reason values beginning with ~ are base-36 references into this table; resolve before display or comparison. Literal leading ~ values use the table.",
);
export interface V9PublicWitnessTextTable { witnessTexts?: readonly V9PublicWitnessTextEntry[] }

const WITNESS_TEXT_REFERENCE = /^~(?:0|[1-9a-z][0-9a-z]*)$/u;

/** Card-local strings shared by public reason and attribution views. */
export function isV9WitnessTextReference(value: string): boolean { return value.startsWith("~"); }
export function isV9WitnessTextField(key: string, node: object): boolean {
  return key === "message" || key === "path" || key === "field" || key === "label" || key === "controlKey" || key === "posture" ||
    key === "key" && "posture" in node && "binding" in node ||
    key === "signalKey" || key === "exposureKey" || key === "riskEventKey" ||
    key === "authorityKey" && "model" in node && !("weightedQuorum" in node || "sameChainSystemTransport" in node) ||
    key === "reason" && ("limit" in node || "exposureKey" in node || "upstreamLabel" in node);
}

export function isV9WitnessTextArrayField(key: string, node: object): boolean {
  return key === "localCauseGaps" || key === "failureDomainKeys" || key === "supportedComponentKeys" || key === "components" && "evidenceLevel" in node;
}
export const V9WitnessTextIdentityArraySchema = z.array(z.string().min(1)).refine(
  (values) => values.some(isV9WitnessTextReference) || values.every((value, index) => index === 0 || values[index - 1]! < value),
  "Witness identities must be unique and sorted after resolution",
);

function decodeWitnessTextTable(card: V9PublicWitnessTextTable): string[] {
  const result: string[] = [];
  for (const entry of card.witnessTexts ?? []) {
    if (typeof entry === "string") { result.push(entry); continue; }
    const [ref, length, suffix] = entry;
    const prefix = result[ref];
    if (!Number.isInteger(ref) || ref < 0 || prefix === undefined ||
        !Number.isInteger(length) || length === 0 || Math.abs(length) > prefix.length || (length > 0 && suffix.length === 0)) {
      throw new Error("Witness text slices must address an earlier entry and an available nonempty slice");
    }
    result.push(length > 0 ? prefix.slice(0, length) + suffix : suffix + prefix.slice(length));
  }
  return result;
}

function witnessTextRef(table: readonly string[], value: string): number {
  if (!WITNESS_TEXT_REFERENCE.test(value)) throw new Error("Invalid witness text reference");
  const ref = Number.parseInt(value.slice(1), 36);
  if (!Number.isSafeInteger(ref) || table[ref] === undefined) throw new Error("Witness text reference is outside the card table");
  return ref;
}

/**
 * Copy-on-write rewrite of every witness-text field; unchanged subtrees keep
 * their identity and the card's own `witnessTexts` table is never visited.
 */
export function mapV9WitnessTextFields(node: unknown, mapText: (value: string) => string): unknown {
  if (Array.isArray(node)) {
    let result: unknown[] | undefined;
    for (let i = 0; i < node.length; i++) {
      const child = mapV9WitnessTextFields(node[i], mapText);
      if (child !== node[i]) { result ??= node.slice(); result[i] = child; }
    }
    return result ?? node;
  }
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  let result: Record<string, unknown> | undefined;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || key === "witnessTexts") continue;
    const value = source[key];
    let child: unknown;
    if (isV9WitnessTextField(key, source) && typeof value === "string") child = mapText(value);
    else if (isV9WitnessTextArrayField(key, source) && Array.isArray(value)) {
      let mapped: unknown[] | undefined;
      for (let index = 0; index < value.length; index++) {
        const entry = value[index];
        const text = typeof entry === "string" ? mapText(entry) : entry;
        if (text !== entry) { mapped ??= value.slice(); mapped[index] = text; }
      }
      child = mapped ?? value;
    } else child = mapV9WitnessTextFields(value, mapText);
    if (child !== value) { result ??= { ...source }; result[key] = child; }
  }
  return result ?? node;
}

export function resolveV9PublicWitnessText(card: V9PublicWitnessTextTable, value: string): string {
  if (card.witnessTexts === undefined || !isV9WitnessTextReference(value)) return value;
  const table = decodeWitnessTextTable(card);
  return table[witnessTextRef(table, value)]!;
}

/** Copy-on-write; no mutation, no expansion of unrelated evidence or gap tables. */
export function resolveV9PublicWitnessTexts<T extends V9PublicWitnessTextTable>(card: T): T {
  // Resolved wire cards have no table. Leading '~' there is literal text, not
  // a canonical reference; also avoid traversing an already resolved cohort.
  if (card.witnessTexts === undefined) return card;
  const table = decodeWitnessTextTable(card);
  const result = mapV9WitnessTextFields(card, (value) =>
    isV9WitnessTextReference(value) ? table[witnessTextRef(table, value)]! : value) as T;
  if (result.witnessTexts === undefined) return result;
  const { witnessTexts: _table, ...semantic } = result;
  return semantic as T;
}

export function validateV9PublicWitnessTexts(card: V9PublicWitnessTextTable): void {
  const table = decodeWitnessTextTable(card);
  if (card.witnessTexts && (table.length === 0 || table.some((text, i) => text.length === 0 || i > 0 && table[i - 1]! >= text))) {
    throw new Error("Witness texts must be nonempty, unique and sorted");
  }
  const used = new Uint8Array(table.length);
  mapV9WitnessTextFields(card, (value) => {
    if (isV9WitnessTextReference(value)) used[witnessTextRef(table, value)] = 1;
    return value;
  });
  if (used.some((entry) => entry === 0)) throw new Error("Every witness text table entry must be referenced");
}

/** Literal-only checks, including escaped strings whose first character is '~'. */
export function validateV9ResolvedWitnessViews(card: Pick<SafetyScoreV9CardValidationInput, "scoreTrace" | "pillars" | "evidence" | "accessPosture" | "breakdowns" | "localCauseGaps">): void {
  const control = card.breakdowns?.control;
  const deployment = card.scoreTrace.deploymentRisk;
  const identities = [
    ...Object.values(card.pillars).flatMap((pillar) => [pillar.components, pillar.supportedComponentKeys]),
    card.localCauseGaps,
    control?.components.map((component) => component.key) ?? [],
    control && "controlDetails" in control ? control.controlDetails?.map((detail) => detail.controlKey) ?? [] : [],
    deployment.adjustments.map((row) => `${row.exposureKey}\u0000${row.riskEventKey}\u0000${row.signalKey}`),
    deployment.unresolvedExposures.map((row) => `${row.exposureKey}\u0000${row.riskEventKey}\u0000${row.failureDomainKeys.join("+")}\u0000${row.signalKey}`),
    ...deployment.unresolvedExposures.map((row) => row.failureDomainKeys),
  ];
  if (identities.some((values) => values.some((value, index) => index > 0 && values[index - 1]! >= value))) {
    throw new Error("V9 resolved witness identities must be unique and sorted");
  }
  for (const reasons of [card.evidence.reasons, ...Object.values(card.pillars).map((pillar) => pillar.reasons), card.accessPosture.reasons]) {
    const identities = new Set<string>();
    for (const reason of reasons) {
      const identity = `${reason.code}\u0000${reason.path ?? ""}`;
      if (identities.has(identity)) throw new Error("V9 public reasons must have unique code/path identities");
      identities.add(identity);
    }
  }
  const adverse = card.scoreTrace.adverseAttribution.items.map((item) => `${item.source}\u0000${item.path}\u0000${item.message}`);
  if (adverse.some((key, i) => i > 0 && adverse[i - 1]! >= key)) throw new Error("V9 adverse attribution must be unique and sorted");
  const bounded = card.scoreTrace.boundedUncertaintyAttribution.items.map((item) => {
    if (item.source === "parent-score" && !item.path.startsWith("parent:")) throw new Error("V9 parent bounded-uncertainty attribution requires a parent-prefixed path");
    return [item.source, item.code, item.path, item.message, item.responsibility].join("\u0000");
  });
  if (bounded.some((key, i) => i > 0 && bounded[i - 1]! >= key)) throw new Error("V9 bounded-uncertainty attribution must be unique and sorted");
}
