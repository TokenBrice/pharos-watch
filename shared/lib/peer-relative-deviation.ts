import { relativeBps } from "./depeg-signals";
import { MIN_PEER_MEDIAN_CONTRIBUTORS } from "./peg-reference-trust";
import { median } from "./stats";

export interface PeerRelativeQuote {
  id: string;
  pegKey: string;
  /** USD per common peg unit, e.g. per troy ounce for every gold token. */
  priceUsd: number;
  observedAtSec: number;
  provenanceKey: string;
  hasOpenEvent: boolean;
}

type SubjectQuote = Pick<PeerRelativeQuote, "id" | "pegKey" | "priceUsd" | "observedAtSec">;

export type PeerRelativeDeviation =
  | { ok: true; deviationBps: number; contributors: PeerRelativeQuote[]; medianUsd: number }
  | { ok: false; reason: "invalid-clock" | "invalid-subject" | "insufficient-peers" | "invalid-deviation" };

function isCurrentQuote(quote: SubjectQuote, nowSec: number, maxAgeSec: number): boolean {
  return quote.id.length > 0 && quote.id === quote.id.trim()
    && Number.isFinite(quote.priceUsd) && quote.priceUsd > 0
    && Number.isSafeInteger(quote.observedAtSec) && quote.observedAtSec > 0
    && quote.observedAtSec <= nowSec && nowSec - quote.observedAtSec <= maxAgeSec;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Signed, unrounded deviation against other independently priced tokens of the same peg. */
export function computePeerRelativeDeviation({ subject, peers, nowSec, maxAgeSec }: {
  subject: SubjectQuote;
  peers: readonly PeerRelativeQuote[];
  nowSec: number;
  maxAgeSec: number;
}): PeerRelativeDeviation {
  if (!Number.isSafeInteger(nowSec) || nowSec <= 0 || !Number.isSafeInteger(maxAgeSec) || maxAgeSec < 0) {
    return { ok: false, reason: "invalid-clock" };
  }
  if (!subject.pegKey.trim() || !isCurrentQuote(subject, nowSec, maxAgeSec)) {
    return { ok: false, reason: "invalid-subject" };
  }

  const excludedIds = new Set(peers.filter((peer) => peer.hasOpenEvent !== false).map((peer) => peer.id));
  excludedIds.add(subject.id);
  const candidates = peers
    .filter((peer) => peer.pegKey === subject.pegKey && peer.provenanceKey.trim()
      && isCurrentQuote(peer, nowSec, maxAgeSec))
    .sort((a, b) => b.observedAtSec - a.observedAtSec || compareKeys(a.id, b.id)
      || compareKeys(a.provenanceKey, b.provenanceKey));

  // Equal-time ties use canonical key order. Conflicting newest prices leave that token unpriced.
  const latestById = new Map<string, PeerRelativeQuote>();
  for (const peer of candidates) {
    const latest = latestById.get(peer.id);
    if (!latest) latestById.set(peer.id, peer);
    else if (peer.observedAtSec === latest.observedAtSec && peer.priceUsd !== latest.priceUsd) excludedIds.add(peer.id);
  }
  const provenance = new Set<string>();
  const contributors: PeerRelativeQuote[] = [];
  for (const peer of latestById.values()) {
    if (excludedIds.has(peer.id)) continue;
    const key = peer.provenanceKey.trim();
    if (provenance.has(key)) continue;
    provenance.add(key);
    contributors.push(peer);
  }
  if (contributors.length < MIN_PEER_MEDIAN_CONTRIBUTORS) return { ok: false, reason: "insufficient-peers" };

  const medianUsd = median(contributors.map((peer) => peer.priceUsd));
  const deviationBps = medianUsd == null ? null : relativeBps(subject.priceUsd, medianUsd)?.rawBps;
  if (medianUsd == null || deviationBps == null || !Number.isFinite(deviationBps)) {
    return { ok: false, reason: "invalid-deviation" };
  }
  return { ok: true, deviationBps, contributors, medianUsd };
}
