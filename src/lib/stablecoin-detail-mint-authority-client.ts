import type { StablecoinMeta } from "@shared/types";
import type { MintAuthorityClientSummary } from "@shared/types/stablecoin-client-meta";
import { isRecord, numberValue, stringValue } from "@shared/lib/type-guards";

type MintAuthorityClientControlSummary = NonNullable<MintAuthorityClientSummary["controls"]>[number];
type MintAuthorityClientSourceSummary = NonNullable<MintAuthorityClientSummary["sources"]>[number];

function canRaiseCapValue(value: unknown): MintAuthorityClientControlSummary["canRaiseCap"] | null {
  return value === true || value === false || value === "unknown" ? value : null;
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

function buildKeyCustodyAttestation(
  value: unknown,
): MintAuthorityClientControlSummary["keyCustodyAttestation"] | undefined {
  if (!isRecord(value)) return undefined;
  const kind = stringValue(value.kind);
  if (kind !== "mpc" && kind !== "hsm") return undefined;
  const sources: MintAuthorityClientSourceSummary[] = [];
  appendSources(sources, value.sources, new Set());
  if (sources.length === 0) return undefined;
  return { kind, sources };
}

function buildMintIncidents(value: unknown): MintAuthorityClientSummary["mintIncidents"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const incidents: NonNullable<MintAuthorityClientSummary["mintIncidents"]> = [];
  for (const incident of value) {
    if (!isRecord(incident)) continue;
    const date = stringValue(incident.date);
    const summary = stringValue(incident.summary);
    if (!date || !summary) continue;
    const sources: MintAuthorityClientSourceSummary[] = [];
    appendSources(sources, incident.sources, new Set());
    if (sources.length === 0) continue;
    incidents.push({ date, summary, sources });
  }
  return incidents.length > 0 ? incidents : undefined;
}

function buildControlSummary(value: unknown): MintAuthorityClientControlSummary | null {
  if (!isRecord(value)) return null;

  const label = stringValue(value.label);
  const role = stringValue(value.role);
  const authorityType = stringValue(value.authorityType);
  const directMintAbility = stringValue(value.directMintAbility);
  if (!label || !role || !authorityType || !directMintAbility) return null;

  // Mint-authority metadata is Zod-validated during the stablecoin-data build;
  // this client projection only strips malformed loose JSON before exposing it.
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
  const canRaiseCap = canRaiseCapValue(value.canRaiseCap);
  const modulesOrGuardsStatus = stringValue(value.modulesOrGuardsStatus);
  const keyCustodyAttestation = buildKeyCustodyAttestation(value.keyCustodyAttestation);

  if (chain) summary.chain = chain;
  if (address) summary.address = address;
  if (threshold != null) summary.threshold = threshold;
  if (signerCount != null) summary.signerCount = signerCount;
  if (timelockDelaySec != null) summary.timelockDelaySec = timelockDelaySec;
  if (capDescription) summary.capDescription = capDescription;
  if (canRaiseCap != null) summary.canRaiseCap = canRaiseCap;
  if (modulesOrGuardsStatus) {
    summary.modulesOrGuardsStatus = modulesOrGuardsStatus as MintAuthorityClientControlSummary["modulesOrGuardsStatus"];
  }
  if (keyCustodyAttestation) summary.keyCustodyAttestation = keyCustodyAttestation;

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

  // The source profile is build-validated; casts here keep the browser payload
  // narrow without duplicating the full metadata schema in frontend code.
  const summary: MintAuthorityClientSummary = {
    mintPath: mintPath as MintAuthorityClientSummary["mintPath"],
    authorityPosture: authorityPosture as MintAuthorityClientSummary["authorityPosture"],
    confidence: confidence as MintAuthorityClientSummary["confidence"],
    summary: summaryText,
  };

  const inheritedFrom = stringValue(profile.inheritedFrom);
  if (inheritedFrom) summary.inheritedFrom = inheritedFrom;
  const mintIncidents = buildMintIncidents(profile.mintIncidents);
  if (mintIncidents) summary.mintIncidents = mintIncidents;

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
  const reviewedAt = stringValue(review?.reviewedAt);
  if (reviewedAt) summary.reviewedAt = reviewedAt;
  for (const incident of mintIncidents ?? []) {
    appendSources(sources, incident.sources, seenUrls);
  }
  appendSources(sources, profile.sources, seenUrls);
  for (const control of Array.isArray(profile.controls) ? profile.controls : []) {
    if (!isRecord(control)) continue;
    appendSources(sources, control.sources, seenUrls);
    const custodyAttestation = isRecord(control.keyCustodyAttestation) ? control.keyCustodyAttestation : null;
    appendSources(sources, custodyAttestation?.sources, seenUrls);
  }
  if (sources.length > 0) summary.sources = sources;

  return summary;
}
