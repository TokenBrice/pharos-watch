import { TRACKED_META_BY_ID } from "./stablecoins";
import type { RedemptionBackstopEntry, RedemptionDocSource, RedemptionDocsProvenance } from "../types/redemption";

type RedemptionDocs = NonNullable<RedemptionBackstopEntry["docs"]>;
type RedemptionDocSources = NonNullable<RedemptionDocs["sources"]>;
type RedemptionDocsConfig = {
  reviewedAt?: string;
  capacityModel: { kind: string };
  docs?: RedemptionDocSource[];
};

function buildDocs(
  config: Pick<RedemptionDocsConfig, "reviewedAt">,
  provenance: RedemptionDocsProvenance,
  sources: RedemptionDocSources,
): RedemptionBackstopEntry["docs"] | undefined {
  if (sources.length === 0) return undefined;
  const [primary] = sources;
  return {
    label: primary.label,
    url: primary.url,
    provenance,
    ...(config.reviewedAt ? { reviewedAt: config.reviewedAt } : {}),
    sources,
  };
}

function pushDedupedSource(sources: RedemptionDocSource[], seen: Set<string>, source: RedemptionDocSource): void {
  const key = `${source.label}:${source.url}`;
  if (seen.has(key)) return;
  seen.add(key);
  sources.push(source);
}

export function trackedRedemptionDocSources(
  stablecoinId: string,
  options?: { includeLiveReserveDisplay?: boolean },
): RedemptionDocSource[] {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) {
    throw new Error(`Unknown tracked stablecoin id "${stablecoinId}" while building redemption docs`);
  }

  const sources: RedemptionDocSource[] = [];
  const seen = new Set<string>();
  const push = (source: RedemptionDocSource) => pushDedupedSource(sources, seen, source);

  if (options?.includeLiveReserveDisplay && meta.liveReservesConfig?.display?.url) {
    push({
      label: meta.liveReservesConfig.display.label ?? "Live reserve source",
      url: meta.liveReservesConfig.display.url,
      supports: ["capacity"],
    });
  }

  if (meta.proofOfReserves?.url) {
    push({
      label: meta.proofOfReserves.provider ? `${meta.proofOfReserves.provider} feed` : "Reserve feed",
      url: meta.proofOfReserves.url,
      supports: ["capacity"],
    });
  }

  for (const link of meta.links ?? []) {
    if (
      link.label === "Docs" ||
      link.label === "Proof of Reserve" ||
      link.label === "Transparency" ||
      link.label === "Website"
    ) {
      push({ label: link.label, url: link.url });
    }
  }

  return sources;
}

export function resolveRedemptionDocs(
  stablecoinId: string,
  config: RedemptionDocsConfig,
): RedemptionBackstopEntry["docs"] | undefined {
  if (config.docs && config.docs.length > 0) {
    return buildDocs(config, "config-reviewed", config.docs);
  }

  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (!meta) return undefined;

  const includeLiveReserveDisplay =
    config.capacityModel.kind === "reserve-sync-metadata" && Boolean(meta.liveReservesConfig?.display?.url);
  const sources = trackedRedemptionDocSources(stablecoinId, { includeLiveReserveDisplay });
  if (sources.length === 0) return undefined;

  if (includeLiveReserveDisplay) {
    return buildDocs(config, "live-reserve-display", sources);
  }
  if (meta.proofOfReserves?.url) {
    return buildDocs(config, "proof-of-reserves", sources);
  }
  return buildDocs(config, "preferred-link", sources);
}
