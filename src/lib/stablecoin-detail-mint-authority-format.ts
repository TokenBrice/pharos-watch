const MINT_AUTHORITY_WEAKEST_CUSTODY_LABELS: Record<string, string> = {
  "single-key address - custody unverifiable": "Single-key address - custody unverifiable",
  "single-key address - MPC-attested": "Single-key address - MPC-attested",
  "single-key address - HSM-attested": "Single-key address - HSM-attested",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function formatMintAuthorityCustodyAttestation(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const kind = stringValue(value.kind);
  if (kind === "mpc") return "MPC-attested custody";
  if (kind === "hsm") return "HSM-attested custody";
  return null;
}

export function formatMintAuthorityWeakestCustodyLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return MINT_AUTHORITY_WEAKEST_CUSTODY_LABELS[value] ?? value;
}
