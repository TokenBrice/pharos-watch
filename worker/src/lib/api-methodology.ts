export interface MethodologyEnvelopeInput {
  version: string;
  versionLabel: string;
  currentVersion: string;
  currentVersionLabel: string;
  changelogPath: string;
  asOf: number;
}

export function buildMethodologyEnvelope({
  version,
  versionLabel,
  currentVersion,
  currentVersionLabel,
  changelogPath,
  asOf,
}: MethodologyEnvelopeInput): MethodologyEnvelopeInput & { isCurrent: boolean } {
  return {
    version,
    versionLabel,
    currentVersion,
    currentVersionLabel,
    changelogPath,
    asOf,
    isCurrent: version === currentVersion,
  };
}
