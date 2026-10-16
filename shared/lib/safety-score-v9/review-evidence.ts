import { stableJsonStringifyBatchChunksV1, stableJsonStringifyChunksV1 } from "../stable-json";
import { sha256HexFromUtf8Chunks } from "../sha256";
import { compareText } from "./primitives";
import type { V9PublishedEvidenceAttribution } from "./evidence";
import type { StablecoinLink } from "../../types/core";
import type { ResearchEvidence, ComponentEvidence } from "../../types/safety-score-v9-research-evidence";

export function parseBoundedDateSec(
  value: string,
  clockSec: number,
  label: string,
  errorKind: "review-date" | "date" = "review-date",
): number {
  const timestampMs = Date.parse(value.includes("T") ? value : `${value}T00:00:00.000Z`);
  const review = errorKind === "review-date";
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`Safety Score v9 ${label} has an invalid ${review ? "review date" : "date"}`);
  }
  const timestampSec = Math.floor(timestampMs / 1_000);
  if (timestampSec > clockSec) {
    throw new Error(`Safety Score v9 ${label}${review ? " review" : ""} is later than the scoring clock`);
  }
  return timestampSec;
}

export class ReviewEvidenceBuilder {
  readonly evidence = new Map<string, ResearchEvidence>();
  readonly bindings = new Map<string, Set<string>>();

  constructor(
    private readonly assetId: string,
    private readonly clockSec: number,
    private readonly digest: (chunks: Iterable<string>) => string = sha256HexFromUtf8Chunks,
  ) {}

  add(args: {
    componentKeys: readonly string[];
    sourceId: string;
    reviewedAt?: string;
    reviewedAtSec?: number;
    observedAtSec?: number;
    observedAt?: string;
    publishedAt?: string;
    publishedBy?: V9PublishedEvidenceAttribution;
    confidence?: ResearchEvidence["confidence"];
    sources?: readonly StablecoinLink[];
    payload: unknown;
    maxAgeSec?: number | null;
  }): string[] {
    if ((args.reviewedAt == null) === (args.reviewedAtSec == null)) {
      throw new Error("Review evidence requires exactly one reviewed date or timestamp");
    }
    const reviewSec = args.reviewedAtSec ?? parseBoundedDateSec(args.reviewedAt!, this.clockSec, `${this.assetId}:${args.sourceId}:reviewed`);
    const observedAtSec = args.observedAtSec ?? (args.reviewedAtSec != null
      ? args.reviewedAtSec
      : parseBoundedDateSec(args.observedAt ?? args.reviewedAt!, this.clockSec, `${this.assetId}:${args.sourceId}:observed`));
    if (args.reviewedAtSec != null || args.observedAtSec != null) {
      for (const timestamp of [reviewSec, observedAtSec]) {
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > this.clockSec) {
          throw new Error("Review evidence timestamp is invalid or later than the scoring clock");
        }
      }
      if (observedAtSec > reviewSec) throw new Error("Evidence observation cannot postdate review");
    }
    const publishedAtSec = args.publishedAt
      ? parseBoundedDateSec(args.publishedAt, this.clockSec, `${this.assetId}:${args.sourceId}:published`)
      : null;
    const sources = args.sources?.length
      ? [...args.sources].sort(
          (left, right) => compareText(left.url, right.url) || compareText(left.label, right.label),
        )
      : [null];
    const envelopes = sources.map((source) => ({
      domain: "safety-score-v9.reviewed-metadata-evidence.v2",
        payload: {
          assetId: this.assetId,
          sourceId: args.sourceId,
          reviewedAt: args.reviewedAtSec ?? args.reviewedAt,
          observedAt: args.observedAtSec ?? args.observedAt ?? args.reviewedAtSec ?? args.reviewedAt,
          publishedAt: args.publishedAt ?? null,
          publishedBy: args.publishedBy ?? "unknown",
          confidence: args.confidence ?? "manual-review",
          source,
          payload: args.payload,
        },
    }));
    // Source URLs alter the envelope, not the often megabyte-sized reviewed
    // profile. Canonicalize that common payload once, without changing a byte
    // of any source-specific evidence digest or retaining it beyond this add.
    const canonicalEnvelopes = sources.length > 1 && args.payload !== null && typeof args.payload === "object"
      ? stableJsonStringifyBatchChunksV1(envelopes, args.payload)
      : envelopes.map(stableJsonStringifyChunksV1);
    const evidenceKeys = sources.map((source, index) => {
      const contentSha256 = this.digest(canonicalEnvelopes[index]!);
      const evidenceKey = `${args.sourceId}:${index}:${contentSha256.slice(0, 16)}`;
      this.evidence.set(evidenceKey, {
        evidenceKey,
        sourceId: args.sourceId,
        observedAtSec,
        publishedAtSec,
        ...(args.publishedBy === undefined ? {} : { publishedBy: args.publishedBy }),
        url: source?.url ?? null,
        contentSha256,
        confidence: args.confidence ?? "manual-review",
        maxAgeSec: args.maxAgeSec ?? null,
      });
      return evidenceKey;
    });
    for (const componentKey of args.componentKeys) {
      const binding = this.bindings.get(componentKey) ?? new Set<string>();
      for (const evidenceKey of evidenceKeys) binding.add(evidenceKey);
      this.bindings.set(componentKey, binding);
    }
    return evidenceKeys;
  }

  finish(): { researchEvidence: ResearchEvidence[]; componentEvidence: ComponentEvidence[] } {
    return {
      researchEvidence: [...this.evidence.values()].sort((left, right) =>
        compareText(left.evidenceKey, right.evidenceKey),
      ),
      componentEvidence: [...this.bindings.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([componentKey, evidenceKeys]) => ({
          componentKey,
          evidenceKeys: [...evidenceKeys].sort(compareText),
        })),
    };
  }
}

