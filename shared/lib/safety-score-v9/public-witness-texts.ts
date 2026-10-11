import type { SafetyScoreV9CurrentCard } from "../../types/safety-score-v9-public";
import type { V9PublicWitnessTextEntry, V9PublicWitnessTextTable } from "../../types/safety-score-v9-public-witness-texts";
export type { V9PublicWitnessTextTable } from "../../types/safety-score-v9-public-witness-texts";

/** Card-local strings shared by public reason and attribution views. */
export function isV9WitnessTextReference(value: string): boolean { return value.startsWith("~"); }
function isWitnessTextField(key: string, node: object): boolean {
  return key === "message" || key === "path" || key === "field" || key === "label" || key === "controlKey" || key === "posture" ||
    key === "reason" && ("limit" in node || "exposureKey" in node || "upstreamLabel" in node);
}

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

export function resolveV9PublicWitnessText(card: V9PublicWitnessTextTable, value: string): string {
  if (!isV9WitnessTextReference(value)) return value;
  if (!/^~(?:0|[1-9a-z][0-9a-z]*)$/u.test(value)) throw new Error("Invalid witness text reference");
  const ref = Number.parseInt(value.slice(1), 36);
  const text = decodeWitnessTextTable(card)[ref];
  if (!Number.isSafeInteger(ref) || text === undefined) throw new Error("Witness text reference is outside the card table");
  return text;
}

/** Copy-on-write; no mutation, no expansion of unrelated evidence or gap tables. */
export function resolveV9PublicWitnessTexts<T extends V9PublicWitnessTextTable>(card: T): T {
  const texts = decodeWitnessTextTable(card);
  const resolveText = (value: string): string => {
    if (!isV9WitnessTextReference(value)) return value;
    if (!/^~(?:0|[1-9a-z][0-9a-z]*)$/u.test(value)) throw new Error("Invalid witness text reference");
    const ref = Number.parseInt(value.slice(1), 36), text = texts[ref];
    if (!Number.isSafeInteger(ref) || text === undefined) throw new Error("Witness text reference is outside the card table");
    return text;
  };
  function resolve(node: unknown): unknown {
    if (Array.isArray(node)) {
      let result: unknown[] | undefined;
      for (let i = 0; i < node.length; i++) {
        const child = resolve(node[i]);
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
      const child = isWitnessTextField(key, source) && typeof value === "string" ? resolveText(value) : resolve(value);
      if (child !== value) { result ??= { ...source }; result[key] = child; }
    }
    return result ?? node;
  }
  const result = resolve(card) as T;
  if (result.witnessTexts === undefined) return result;
  const { witnessTexts: _table, ...semantic } = result;
  return semantic as T;
}

/** Intern only where the canonical JSON is smaller; reserved leading '~' literals are always escaped. */
export function internV9PublicWitnessTexts<T extends object>(card: T): T & V9PublicWitnessTextTable {
  const counts = new Map<string, number>();
  function collect(node: unknown): void {
    if (Array.isArray(node)) { for (const child of node) collect(child); return; }
    if (node === null || typeof node !== "object") return;
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const value = (node as Record<string, unknown>)[key];
      if (isWitnessTextField(key, node) && typeof value === "string") counts.set(value, (counts.get(value) ?? 0) + 1);
      else collect(value);
    }
  }
  collect(card);
  const texts = [...counts.keys()].sort();
  // Nearest already-admitted neighbours in reverse lexical order have the
  // longest common suffix. Monotone stacks find both without pairwise scans.
  const reverseOrder = texts.map((_, index) => index).sort((a, b) => {
    const left = texts[a]!, right = texts[b]!;
    for (let offset = 1; offset <= Math.min(left.length, right.length); offset++) {
      const difference = left.charCodeAt(left.length - offset) - right.charCodeAt(right.length - offset);
      if (difference !== 0) return difference;
    }
    return left.length - right.length;
  });
  const suffixNeighbours: number[][] = texts.map(() => []);
  for (const order of [reverseOrder, [...reverseOrder].reverse()]) {
    const stack: number[] = [];
    for (const ref of order) {
      while (stack.length > 0 && stack[stack.length - 1]! > ref) stack.pop();
      if (stack.length > 0) suffixNeighbours[ref]!.push(stack[stack.length - 1]!);
      stack.push(ref);
    }
  }
  const witnessTexts: V9PublicWitnessTextEntry[] = [];
  for (let ref = 0; ref < texts.length; ref++) {
    const text = texts[ref]!, literal = JSON.stringify(text);
    const previous = texts[ref - 1];
    let prefixLength = 0;
    if (previous !== undefined) {
      while (prefixLength < previous.length && prefixLength < text.length &&
          previous.charCodeAt(prefixLength) === text.charCodeAt(prefixLength)) prefixLength++;
    }
    const prefix: V9PublicWitnessTextEntry = [ref - 1, prefixLength, text.slice(prefixLength)];
    const prefixBytes = JSON.stringify(prefix).length;
    let entry: V9PublicWitnessTextEntry = prefixLength > 0 && prefixBytes < literal.length ? prefix : text;
    let entryBytes = entry === text ? literal.length : prefixBytes;
    for (const neighbour of suffixNeighbours[ref]!) {
      const earlier = texts[neighbour]!;
      let suffixLength = 0;
      while (suffixLength < earlier.length && suffixLength < text.length &&
          earlier.charCodeAt(earlier.length - suffixLength - 1) === text.charCodeAt(text.length - suffixLength - 1)) suffixLength++;
      if (suffixLength === 0) continue;
      const suffix: V9PublicWitnessTextEntry = [neighbour, -suffixLength, text.slice(0, text.length - suffixLength)];
      const suffixBytes = JSON.stringify(suffix).length;
      if (suffixBytes < entryBytes) { entry = suffix; entryBytes = suffixBytes; }
    }
    witnessTexts.push(entry);
  }
  // Remove unprofitable leaves, but keep every prefix/suffix anchor used by a
  // retained entry and every escaped leading '~' literal. Rebase all references.
  const anchors = new Uint8Array(witnessTexts.length);
  for (const entry of witnessTexts) if (Array.isArray(entry)) anchors[entry[0]] = 1;
  const remapped = new Uint32Array(witnessTexts.length);
  const refs = new Map<string, string>();
  let retained = 0, literalBytes = 0, wireBytes = '"witnessTexts":[],'.length;
  let reservedLiteral = false;
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!, entry = witnessTexts[index]!, count = counts.get(text)!;
    const literalLength = JSON.stringify(text).length;
    const token = `~${retained.toString(36)}`, tokenLength = JSON.stringify(token).length;
    const rebased: V9PublicWitnessTextEntry = typeof entry === "string" ? entry : [remapped[entry[0]]!, entry[1], entry[2]];
    const entryLength = JSON.stringify(rebased).length;
    if (!anchors[index] && !text.startsWith("~") && count * literalLength <= count * tokenLength + entryLength + 1) continue;
    remapped[index] = retained;
    witnessTexts[retained++] = rebased;
    refs.set(text, token);
    literalBytes += count * literalLength;
    wireBytes += count * tokenLength + entryLength + 1;
    reservedLiteral ||= text.startsWith("~");
  }
  witnessTexts.length = retained;
  if (witnessTexts.length === 0 || !reservedLiteral && wireBytes >= literalBytes) return card;
  function compact(node: unknown): unknown {
    if (Array.isArray(node)) {
      let result: unknown[] | undefined;
      for (let i = 0; i < node.length; i++) {
        const child = compact(node[i]);
        if (child !== node[i]) { result ??= node.slice(); result[i] = child; }
      }
      return result ?? node;
    }
    if (node === null || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      const child = isWitnessTextField(key, source) && typeof value === "string" ? refs.get(value) ?? value : compact(value);
      if (child !== value) { result ??= { ...source }; result[key] = child; }
    }
    return result ?? node;
  }
  return { ...(compact(card) as T), witnessTexts };
}

export function validateV9PublicWitnessTexts(card: V9PublicWitnessTextTable): void {
  const table = decodeWitnessTextTable(card);
  if (card.witnessTexts && (table.length === 0 || table.some((text, i) => text.length === 0 || i > 0 && table[i - 1]! >= text))) {
    throw new Error("Witness texts must be nonempty, unique and sorted");
  }
  const used = new Uint8Array(table.length);
  function visit(node: unknown): void {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node === null || typeof node !== "object") return;
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key) || key === "witnessTexts") continue;
      const value = (node as Record<string, unknown>)[key];
      if (isWitnessTextField(key, node) && typeof value === "string" && isV9WitnessTextReference(value)) {
        if (!/^~(?:0|[1-9a-z][0-9a-z]*)$/u.test(value)) throw new Error("Invalid witness text reference");
        const ref = Number.parseInt(value.slice(1), 36);
        if (!Number.isSafeInteger(ref) || table[ref] === undefined) throw new Error("Witness text reference is outside the card table");
        used[ref] = 1;
      } else visit(value);
    }
  }
  visit(card);
  if (used.some((entry) => entry === 0)) throw new Error("Every witness text table entry must be referenced");
}

/** Literal-only checks, including escaped strings whose first character is '~'. */
export function validateV9ResolvedWitnessViews(card: Pick<SafetyScoreV9CurrentCard, "scoreTrace" | "pillars" | "evidence" | "accessPosture">): void {
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
    if (item.source === "wrapper-local" && !item.path.startsWith("wrapper-local:")) throw new Error("V9 wrapper bounded-uncertainty attribution requires a wrapper-local path");
    return [item.source, item.code, item.path, item.message, item.responsibility].join("\u0000");
  });
  if (bounded.some((key, i) => i > 0 && bounded[i - 1]! >= key)) throw new Error("V9 bounded-uncertainty attribution must be unique and sorted");
}
