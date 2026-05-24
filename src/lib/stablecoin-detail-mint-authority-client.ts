import type { StablecoinMeta } from "@shared/types";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";

type UnknownRecord = Record<string, unknown>;
type MintAuthorityClientControlSummary = NonNullable<MintAuthorityClientSummary["controls"]>[number];
type MintAuthorityClientSourceSummary = NonNullable<MintAuthorityClientSummary["sources"]>[number];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function appendSources(target: MintAuthorityClientSourceSummary[], sources: unknown, seenUrls: Set<string>) {
  if (!Array.isArray(sources)) return;

  for (const source of sources) {
    if (!isRecord(source)) continue;
    const label = stringValue(source.label);
    const url = stringValue(source.url);
    if (!label || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    target.push({ label, url });
  }
}

function buildControlSummary(value: unknown): MintAuthorityClientControlSummary | null {
  if (!isRecord(value)) return null;

  const label = stringValue(value.label);
  const role = stringValue(value.role);
  const authorityType = stringValue(value.authorityType);
  const directMintAbility = stringValue(value.directMintAbility);
  if (!label || !role || !authorityType || !directMintAbility) return null;

  const summary: MintAuthorityClientControlSummary = {
    label,
    role: role as MintAuthorityClientControlSummary["role"],
    authorityType: authorityType as MintAuthorityClientControlSummary["authorityType"],
    directMintAbility: directMintAbility as MintAuthorityClientControlSummary["directMintAbility"],
  };

  const chain = stringValue(value.chain);
  const address = stringValue(value.address);
  const threshold = numberValue(value.threshold);
  const signerCount = numberValue(value.signerCount);
  const timelockDelaySec = numberValue(value.timelockDelaySec);
  const capDescription = stringValue(value.capDescription);
  const modulesOrGuardsStatus = stringValue(value.modulesOrGuardsStatus);

  if (chain) summary.chain = chain;
  if (address) summary.address = address;
  if (threshold != null) summary.threshold = threshold;
  if (signerCount != null) summary.signerCount = signerCount;
  if (timelockDelaySec != null) summary.timelockDelaySec = timelockDelaySec;
  if (capDescription) summary.capDescription = capDescription;
  if (modulesOrGuardsStatus) {
    summary.modulesOrGuardsStatus = modulesOrGuardsStatus as MintAuthorityClientControlSummary["modulesOrGuardsStatus"];
  }

  return summary;
}

export function projectMintAuthorityClientSummary(coin: StablecoinMeta): MintAuthorityClientSummary | null {
  const profile = isRecord(coin.mintAuthority) ? coin.mintAuthority : null;
  if (!profile) return null;

  const mintPath = stringValue(profile.mintPath);
  const authorityPosture = stringValue(profile.authorityPosture);
  const confidence = stringValue(profile.confidence);
  const summaryText = stringValue(profile.summary);
  if (!mintPath || !authorityPosture || !confidence || !summaryText) return null;

  const summary: MintAuthorityClientSummary = {
    mintPath: mintPath as MintAuthorityClientSummary["mintPath"],
    authorityPosture: authorityPosture as MintAuthorityClientSummary["authorityPosture"],
    confidence: confidence as MintAuthorityClientSummary["confidence"],
    summary: summaryText,
  };

  const inheritedFrom = stringValue(profile.inheritedFrom);
  if (inheritedFrom) summary.inheritedFrom = inheritedFrom;

  const controls = Array.isArray(profile.controls)
    ? profile.controls
        .map(buildControlSummary)
        .filter((control): control is MintAuthorityClientControlSummary => control !== null)
    : [];
  if (controls.length > 0) summary.controls = controls;

  const sources: MintAuthorityClientSourceSummary[] = [];
  const seenUrls = new Set<string>();
  const review = isRecord(profile.review) ? profile.review : null;
  appendSources(sources, review?.sources, seenUrls);
  appendSources(sources, profile.sources, seenUrls);
  for (const control of Array.isArray(profile.controls) ? profile.controls : []) {
    if (isRecord(control)) appendSources(sources, control.sources, seenUrls);
  }
  if (sources.length > 0) summary.sources = sources;

  return summary;
}
