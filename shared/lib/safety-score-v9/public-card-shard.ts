import { strFromU8, strToU8 } from "fflate";
import type { SafetyScoreV9CurrentCard } from "../../types/safety-score-v9-public";
import { deepFreeze } from "../../types/safety-score-v9-immutable";

function fieldGetter(
  read: (bytes: Uint8Array) => SafetyScoreV9CurrentCard,
  bytes: Uint8Array,
  key: keyof SafetyScoreV9CurrentCard,
): () => SafetyScoreV9CurrentCard[keyof SafetyScoreV9CurrentCard] {
  // A getter owns only the serialized card, never the original object graph.
  return () => read(bytes)[key];
}

/** Invocation-private admitted cards; uncompressed bytes avoid per-card codec work. */
export function createV9PublicCardShardViewFactory(): (card: SafetyScoreV9CurrentCard) => SafetyScoreV9CurrentCard {
  // Parent comparisons revisit nearby cards; bound reuse without retaining the cohort.
  const decoded = new Map<Uint8Array, SafetyScoreV9CurrentCard>();
  let cachedBytes: Uint8Array | null = null;
  let cachedCard: SafetyScoreV9CurrentCard | null = null;
  function read(bytes: Uint8Array): SafetyScoreV9CurrentCard {
    if (cachedBytes === bytes) return cachedCard!;
    let card = decoded.get(bytes);
    if (card === undefined) {
      card = deepFreeze(JSON.parse(strFromU8(bytes)) as SafetyScoreV9CurrentCard);
      if (decoded.size === 32) decoded.delete(decoded.keys().next().value!);
    } else {
      decoded.delete(bytes);
    }
    decoded.set(bytes, card);
    cachedBytes = bytes;
    cachedCard = card;
    return card;
  }
  return (card) => {
    const bytes = strToU8(JSON.stringify(card));
    const descriptors: PropertyDescriptorMap = {};
    for (const key of Object.keys(card) as Array<keyof SafetyScoreV9CurrentCard>) {
      const value = card[key];
      descriptors[key] = value !== null && typeof value === "object"
        ? { enumerable: true, get: fieldGetter(read, bytes, key) }
        : { enumerable: true, value };
    }
    return Object.freeze(Object.defineProperties({}, descriptors)) as SafetyScoreV9CurrentCard;
  };
}
