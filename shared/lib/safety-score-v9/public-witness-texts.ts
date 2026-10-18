import {
  isV9WitnessTextField,
  mapV9WitnessTextFields,
  type V9PublicWitnessTextEntry,
} from "../../types/safety-score-v9-public-witness-texts";

/** Intern only where the canonical JSON is smaller; reserved leading '~' literals are always escaped. */
export function internV9PublicWitnessTexts<T extends object>(card: T): Omit<T, "witnessTexts"> & { witnessTexts?: V9PublicWitnessTextEntry[] } {
  const counts = new Map<string, number>();
  function collect(node: unknown): void {
    if (Array.isArray(node)) { for (const child of node) collect(child); return; }
    if (node === null || typeof node !== "object") return;
    for (const key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const value = (node as Record<string, unknown>)[key];
      if (isV9WitnessTextField(key, node) && typeof value === "string") counts.set(value, (counts.get(value) ?? 0) + 1);
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
  return { ...(mapV9WitnessTextFields(card, (value) => refs.get(value) ?? value) as T), witnessTexts };
}
