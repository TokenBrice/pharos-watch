#!/usr/bin/env node

/**
 * Worker runtime lookup for mint/burn raw-token conservation eligibility.
 *
 * The committed evidence sidecar (`worker/src/lib/mint-burn-conservation-reviewed.json`)
 * carries the full reviewer evidence — identity proof, supply-path review, audited
 * windows — and grows with every admission wave. The Worker must not parse it at
 * isolate startup on the mint/burn lane (ADR-23/24/25 CPU/memory history, 128 MB
 * limit), so this generator projects it down to the identity and eligibility
 * fields and writes `worker/src/lib/mint-burn-conservation-runtime.generated.json`,
 * the only conservation file the Worker imports. Tests, the admission CLI, and
 * docs keep reading the sidecar directly.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIDECAR_REL = "worker/src/lib/mint-burn-conservation-reviewed.json";
const OUTPUT_REL = "worker/src/lib/mint-burn-conservation-runtime.generated.json";

/** Identity and eligibility fields only; every other sidecar key is evidence. */
const RUNTIME_ENTRY_KEYS = [
  "chainId",
  "stablecoinId",
  "address",
  "decimals",
  "disposition",
  "unsupportedReason",
  "eventSet",
  "invariant",
  "conservationOnlyEvents",
  "requiresNotDeprecated",
  "invariantParams",
] as const;

export interface MintBurnConservationRuntimeEntry {
  chainId: string;
  stablecoinId: string;
  address: string;
  decimals: number;
  disposition: "admitted" | "unsupported";
  unsupportedReason?: string;
  eventSet?: "transfer" | "config-events";
  invariant?: string;
  conservationOnlyEvents?: unknown[];
  requiresNotDeprecated?: boolean;
  invariantParams?: Record<string, unknown>;
}

export interface MintBurnConservationRuntimeLookup {
  version: 1;
  entries: MintBurnConservationRuntimeEntry[];
}

/**
 * Project one sidecar document to the runtime lookup. Sidecar entry order is
 * preserved (the sidecar is sorted by identity), keys that are absent or null
 * on the source entry are omitted, and `unsupportedReason` — present as `null`
 * on every admitted sidecar entry — survives only on unsupported entries.
 */
export function projectMintBurnConservationRuntime(sidecar: unknown): MintBurnConservationRuntimeLookup {
  if (typeof sidecar !== "object" || sidecar === null) {
    throw new Error(`${SIDECAR_REL}: expected { version: 1, entries: [...] }`);
  }
  const { version, entries: rawEntries } = sidecar as { version?: unknown; entries?: unknown };
  if (version !== 1 || !Array.isArray(rawEntries)) {
    throw new Error(`${SIDECAR_REL}: expected { version: 1, entries: [...] }`);
  }
  const entries = rawEntries.map((raw, index): MintBurnConservationRuntimeEntry => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${SIDECAR_REL}: entry ${index} is not an object`);
    }
    const source = raw as Record<string, unknown>;
    const { chainId, stablecoinId, address, decimals, disposition } = source;
    if (typeof chainId !== "string" || typeof stablecoinId !== "string" || typeof address !== "string" ||
      typeof decimals !== "number" || (disposition !== "admitted" && disposition !== "unsupported")) {
      throw new Error(`${SIDECAR_REL}: entry ${index} is missing its identity/disposition core`);
    }
    const entry: MintBurnConservationRuntimeEntry = { chainId, stablecoinId, address, decimals, disposition };
    const runtimeEntry = entry as unknown as Record<string, unknown>;
    for (const key of RUNTIME_ENTRY_KEYS) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (key === "unsupportedReason" && disposition !== "unsupported") continue;
      runtimeEntry[key] = value;
    }
    return entry;
  });
  return { version: 1, entries };
}

/** Byte-exact committed form of the runtime lookup: 2-space JSON, trailing newline. */
export function renderMintBurnConservationRuntime(sidecar: unknown): string {
  return `${JSON.stringify(projectMintBurnConservationRuntime(sidecar), null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sidecar: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, SIDECAR_REL), "utf8"));
  const entryCount = projectMintBurnConservationRuntime(sidecar).entries.length;
  syncGeneratedArtifacts({
    artifacts: [{ path: resolve(REPO_ROOT, OUTPUT_REL), contents: renderMintBurnConservationRuntime(sidecar) }],
    check: process.argv.includes("--check"),
    staleMessage: `${OUTPUT_REL} is stale. Run \`tsx scripts/maintenance/generate-mint-burn-conservation-runtime.ts\`.`,
    currentMessage: `${OUTPUT_REL}: matches ${SIDECAR_REL} (${entryCount} entries)`,
    writtenMessage: `${OUTPUT_REL}: projected ${entryCount} entries from ${SIDECAR_REL}`,
  });
}
