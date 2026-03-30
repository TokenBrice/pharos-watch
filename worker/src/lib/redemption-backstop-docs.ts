import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

function buildDocs(
  config: RedemptionBackstopConfig,
  provenance: NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["provenance"]>,
  sources: NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["sources"]>,
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

export function resolveRedemptionDocs(
  stablecoinId: string,
  config: RedemptionBackstopConfig,
): RedemptionBackstopEntry["docs"] | undefined {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  if (config.docs && config.docs.length > 0) {
    return buildDocs(config, "config-reviewed", config.docs);
  }

  if (!meta) return undefined;

  const sources: NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["sources"]> = [];
  const seen = new Set<string>();
  const pushSource = (source: NonNullable<NonNullable<RedemptionBackstopEntry["docs"]>["sources"]>[number]) => {
    const key = `${source.label}:${source.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  };

  if (
    config.capacityModel.kind === "reserve-sync-metadata"
    && meta.liveReservesConfig?.display?.url
  ) {
    pushSource({
      label: meta.liveReservesConfig.display.label ?? "Live reserve source",
      url: meta.liveReservesConfig.display.url,
      supports: ["capacity"],
    });
  }

  if (meta.proofOfReserves?.url) {
    pushSource({
      label: meta.proofOfReserves.provider ? `${meta.proofOfReserves.provider} feed` : "Reserve feed",
      url: meta.proofOfReserves.url,
      supports: ["capacity"],
    });
  }

  const preferredLink = meta.links?.find(
    (link) =>
      link.label === "Docs"
      || link.label === "Proof of Reserve"
      || link.label === "Transparency"
      || link.label === "Website",
  );
  if (preferredLink) {
    pushSource({
      label: preferredLink.label,
      url: preferredLink.url,
    });
  }

  if (sources.length === 0) return undefined;
  if (config.capacityModel.kind === "reserve-sync-metadata" && meta.liveReservesConfig?.display?.url) {
    return buildDocs(config, "live-reserve-display", sources);
  }
  if (meta.proofOfReserves?.url) {
    return buildDocs(config, "proof-of-reserves", sources);
  }
  return buildDocs(config, "preferred-link", sources);
}
