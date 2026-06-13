import { isRecord, stringValue } from "@shared/lib/type-guards";

export function formatMintAuthorityCustodyAttestation(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const kind = stringValue(value.kind);
  if (kind === "mpc") return "MPC-attested custody";
  if (kind === "hsm") return "HSM-attested custody";
  return null;
}

export function formatMintAuthorityWeakestCustodyLabel(value: string | null | undefined): string | null {
  return value || null;
}
