import type { CollectedConfirmationEvidence } from "../pending-depeg-confirmation";

export function emptyEvidence(): CollectedConfirmationEvidence {
  return { confirmingSources: [], opposingSources: [], unavailableSources: [], circuitOpenSources: [], hardOpposingSources: [], offchainStatus: "insufficient", offchainSourceKey: null, offchainPeakCandidate: null, dexStatus: "insufficient", dexPeakCandidates: [], dexConfirmationKeys: [], cexStatus: "insufficient", cexPeakCandidate: null, poolStatus: "insufficient", poolConfirmations: [] };
}
