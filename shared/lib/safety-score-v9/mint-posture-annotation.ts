import type { MintAuthorityPosture } from "../../types/core";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { compareText, deepFreeze } from "./primitives";
import {
  V9_MINT_POSTURE_BAND_ORDER,
  curatedMintPostureBand,
  resolveV9MintPostureBand,
  type V9MintPostureBand,
} from "./mint-posture";

const V9_CURATED_MINT_POSTURE_QUEUE_DIGEST_DOMAIN = "safety-score-v9.curated-mint-posture-queue.v1";

/**
 * Safety 9.1 demoted the curated `mintAuthority.authorityPosture` field to a
 * validated annotation. V9's derived posture is canonical and is the only one
 * that scores; the curated value is compared against it and any disagreement
 * becomes a curation item here, never a score effect.
 *
 * This follows the evidence-gap-queue pattern: a pure function over published
 * facts, a strict entry shape, deterministic ordering, and a content digest so
 * two runs over the same publication are byte-identical.
 */
export type V9CuratedMintPostureDisagreement =
  | "curated-optimistic"
  | "curated-adverse"
  | "curated-unreviewed"
  | "derived-unresolved";

export interface V9CuratedMintPostureQueueEntry {
  assetId: string;
  curatedPosture: MintAuthorityPosture;
  curatedBand: V9MintPostureBand | null;
  derivedPosture: string;
  derivedBand: V9MintPostureBand | null;
  disagreement: V9CuratedMintPostureDisagreement;
  action: string;
}

export interface V9CuratedMintPostureQueue {
  schemaVersion: 1;
  kind: "safety-score-v9-curated-mint-posture-queue";
  reviewedAssetCount: number;
  entries: readonly V9CuratedMintPostureQueueEntry[];
  /**
   * Assets whose card publishes no breakdowns at all — an NR card. V9 derived no
   * mint posture for them because it rated nothing, so a curated annotation
   * cannot disagree with a derivation that does not exist. They are reported
   * here rather than counted as `derived-unresolved` disagreements: the action
   * for an NR card is to close its rating gap, not to re-curate its posture.
   */
  nrCards: readonly string[];
  queueDigest: string;
}

export interface V9CuratedMintPostureInput {
  assetId: string;
  /** Curated annotation from `mintAuthority.authorityPosture`, if reviewed. */
  curatedPosture: MintAuthorityPosture | null | undefined;
  /** Posture published on the V9 control breakdown's mint component. */
  derivedPosture: string | null | undefined;
  /**
   * False when the published card carries no `breakdowns` (NR). Defaults to
   * true so a caller that only has postures keeps the previous behaviour.
   */
  publishesBreakdowns?: boolean;
}

const BAND_RANK = new Map<V9MintPostureBand, number>(
  V9_MINT_POSTURE_BAND_ORDER.map((band, index) => [band, index]),
);

const ACTIONS: Record<V9CuratedMintPostureDisagreement, string> = {
  "curated-optimistic":
    "The curated annotation claims a stronger mint posture than the reviewed control facts support. Re-read the control row's cap semantics, claim impairment and reconciliation, then correct whichever side is wrong.",
  "curated-adverse":
    "The curated annotation claims a weaker mint posture than the reviewed control facts support. Either the control facts are missing an authority the annotation knows about, or the annotation is stale.",
  "curated-unreviewed":
    "The mint posture is derived but the curated annotation is still unknown. Fill in `mintAuthority.authorityPosture` so the annotation can keep validating the derivation.",
  "derived-unresolved":
    "The curated annotation names a posture that the control facts cannot derive. Author the missing control semantics so the pillar stops holding the bounded-unknown quality.",
};

function classify(
  curatedBand: V9MintPostureBand | null,
  derivedBand: V9MintPostureBand | null,
): V9CuratedMintPostureDisagreement | null {
  if (curatedBand === null && derivedBand === null) return null;
  if (curatedBand === null) return "curated-unreviewed";
  if (derivedBand === null) return "derived-unresolved";
  if (curatedBand === derivedBand) return null;
  // Until the curated vocabulary gained `unbounded-reconciled` it could not
  // express the reconciled rung, so an "exposed" annotation over a "managed"
  // derivation was suppressed as the expected shape of that split. The
  // vocabulary now carries the rung and every affected asset is annotated with
  // it, so the suppression would only hide a real disagreement.
  return BAND_RANK.get(curatedBand)! < BAND_RANK.get(derivedBand)! ? "curated-optimistic" : "curated-adverse";
}

/**
 * Build the curated-vs-derived mint posture queue. Assets whose annotation and
 * derivation agree, and assets with neither, produce no entry.
 */
export function buildV9CuratedMintPostureQueue(
  inputs: readonly V9CuratedMintPostureInput[],
): V9CuratedMintPostureQueue {
  const entries: V9CuratedMintPostureQueueEntry[] = [];
  const nrCards: string[] = [];
  for (const input of inputs) {
    // An NR card derives no posture because nothing was rated. Treating that
    // absence as `derived-unresolved` blamed curation for a rating gap and
    // inflated the disagreement count.
    if (input.publishesBreakdowns === false) {
      nrCards.push(input.assetId);
      continue;
    }
    const curatedPosture = input.curatedPosture ?? "unknown";
    // The curated side must resolve through the curated projection: the curated
    // vocabulary carries values V9 never derives (`none-resolved-mint`), and
    // resolving those against the derived map alone would report them as
    // unreviewed rather than as the agreement they are.
    const curatedBand = curatedMintPostureBand(curatedPosture);
    const derivedBand = resolveV9MintPostureBand(input.derivedPosture);
    const disagreement = classify(curatedBand, derivedBand);
    if (disagreement === null) continue;
    entries.push({
      assetId: input.assetId,
      curatedPosture,
      curatedBand,
      derivedPosture: input.derivedPosture ?? "unknown",
      derivedBand,
      disagreement,
      action: ACTIONS[disagreement],
    });
  }
  entries.sort((left, right) => compareText(left.assetId, right.assetId));
  nrCards.sort(compareText);
  const core = {
    schemaVersion: 1 as const,
    kind: "safety-score-v9-curated-mint-posture-queue" as const,
    reviewedAssetCount: inputs.length,
    entries,
    nrCards,
  };
  return deepFreeze({ ...core, queueDigest: sha256Hex(`${V9_CURATED_MINT_POSTURE_QUEUE_DIGEST_DOMAIN}:${stableJsonStringifyV1(core)}`) });
}
