import type { PublicClient } from "viem";
import type { FailureScenario } from "../../types/failure-scenarios";
import crvusdChecks from "./crvusd-curve";
import ghoChecks from "./gho-aave";
import usdcChecks from "./usdc-circle";
import usdeChecks from "./usde-ethena";
import usdsChecks from "./usds-sky";
import usdtChecks from "./usdt-tether";
import usd1Checks from "./usd1-world-liberty-financial";
import lusdChecks from "./lusd-liquity";

/** Injected read-only viem actions. No wallet, transaction, transport or Node APIs. */
export type ScenarioReadClient = Pick<PublicClient,
  "readContract" | "call" | "getBytecode" | "getStorageAt" | "getLogs" |
  "getBlock" | "getBalance" | "getTransaction" | "getTransactionReceipt" | "getBlockNumber"
>;

export interface ScenarioChainContext {
  client: ScenarioReadClient;
  /** Resolve once per chain at runner startup; every current-state read uses this pin. */
  blockNumber: bigint;
}

export interface ScenarioCheckContext {
  /** The authoritative record, injected rather than imported into each coin module. */
  record: FailureScenario;
  /** Numeric EVM chain ids. Missing chains must produce unavailable, never holds. */
  chains: Readonly<Partial<Record<number, ScenarioChainContext>>>;
  /** Runner-fetched documents and reviewed baselines for the current document watch. */
  documentWatch?: {
    recorded: readonly ScenarioDocument[];
    fetched: readonly ScenarioDocument[];
  };
}

/** JSON-safe evidence: convert bigint to decimal strings before returning values. */
export type ScenarioCheckValue = string | number | boolean | null |
  ScenarioCheckValue[] | { [key: string]: ScenarioCheckValue };

export type ScenarioCheckVerdict =
  | { verdict: "holds"; observed: ScenarioCheckValue; recorded: ScenarioCheckValue; reason?: string }
  | { verdict: "changed"; observed: ScenarioCheckValue; recorded: ScenarioCheckValue; reason?: string }
  | { verdict: "unavailable"; reason: string; observed?: ScenarioCheckValue; recorded?: ScenarioCheckValue };

export interface ScenarioDocumentFingerprint {
  contentHash: string;
  /** PDF byte hash also catches visual/font changes not faithfully extracted as text. */
  fileHash?: string;
  /** Corroborating transport metadata only; CDN drift cannot decide a watch. */
  lastModified: string | null;
  etag: string | null;
  revision: string | null;
}

/** A failed fetch never has a fingerprint; normalizedText supports a human diff. */
export interface ScenarioDocument {
  sourceId: string;
  url: string;
  publisher: string;
  fetchedAt: string;
  fingerprint?: ScenarioDocumentFingerprint;
  normalizedText?: string;
  unavailableReason?: string;
}

export type ScenarioDocumentBaselines = Record<string, Record<string, ScenarioDocument[]>>;

/**
 * Each coin module default-exports readonly ScenarioCheck[]. id is a falsifier id
 * from the injected record; multiple checks may test the same falsifier. All reads
 * are read-only and pinned. Historical baseline reads use checkedAtBlock/source
 * blocks explicitly; never silently substitute current state for a baseline.
 * holds means the tested premise still holds, not that every numerical value is
 * identical (e.g. a voting-share check tests the recorded 51% boundary). changed
 * is drift requiring human review, NOT an automatic declaration of status=met.
 * A failed read returns unavailable (or throws, which the runner converts to it).
 * No check means unchecked in the report, not a successful verification.
 * Only changed falsifiers and unchecked falsifiers fail the run. unavailable
 * requests human review and has its own count; it never implies holds or failure.
 * Numeric published figures use kind="figure", a unique id, and recordField
 * naming the keyFigures/exposure entry by its label. Drift is informational,
 * appears in a separate figures-to-refresh section, and never fails the run.
 * Other supplemental facts use kind="observation"; these are also informational
 * and never count as falsifier coverage or substitute for off-chain review.
 * Document watches use kind="document" and register a human-review route for a
 * falsifier, not a decisive check. Fingerprint drift is separately reported and
 * never fails the run; even unchanged documents leave the condition a judgement.
 */
export type ScenarioCheck = {
  id: string;
  label: string;
  run(context: ScenarioCheckContext): Promise<ScenarioCheckVerdict>;
} & (
  | { kind?: "falsifier"; recordField?: never }
  | { kind: "figure"; recordField: { collection: "keyFigures" | "exposure"; label: string } }
  | { kind: "observation"; recordField?: never }
  | { kind: "document"; recordField?: never; documentSources: readonly { sourceId: string; publisher: string }[]; humanReviewReason: string }
);

/** A matching source is unchanged text, never a re-decision of the falsifier. */
export function scenarioDocumentWatch(
  id: string,
  label: string,
  documentSources: readonly { sourceId: string; publisher: string }[],
  humanReviewReason: string,
): ScenarioCheck {
  return {
    kind: "document", id, label, documentSources, humanReviewReason,
    async run(context) {
      const review = documentSources.map(({ sourceId }) => {
        const source = context.record.sources.find((entry) => entry.id === sourceId);
        if (!source) throw new Error(`Missing recorded document source ${sourceId}`);
        return `${source.label} (${source.url})`;
      });
      const reason = `A human must re-read ${review.join("; ")}. ${humanReviewReason}`;
      if (!context.documentWatch) return { verdict: "unavailable", reason: `Runner did not fetch watched documents. ${reason}` };
      const { recorded, fetched } = context.documentWatch;
      const evidence = (documents: readonly ScenarioDocument[]): ScenarioCheckValue => documents.map((document) => ({
        sourceId: document.sourceId, url: document.url, publisher: document.publisher,
        fetchedAt: document.fetchedAt, fingerprint: document.fingerprint ? {
          contentHash: document.fingerprint.contentHash, fileHash: document.fingerprint.fileHash ?? null,
          lastModified: document.fingerprint.lastModified, etag: document.fingerprint.etag,
          revision: document.fingerprint.revision,
        } : null,
        unavailableReason: document.unavailableReason ?? null,
      }));
      const unavailable: string[] = [];
      let changed = false;
      const differences: ScenarioCheckValue[] = [];
      const transportMetadataChanges: ScenarioCheckValue[] = [];
      for (const { sourceId } of documentSources) {
        const baseline = recorded.find((entry) => entry.sourceId === sourceId);
        const observed = fetched.find((entry) => entry.sourceId === sourceId);
        if (!observed?.fingerprint) {
          unavailable.push(`${sourceId}: ${observed?.unavailableReason ?? "Document was not fetched"}`);
          continue;
        }
        if (!baseline?.fingerprint) {
          unavailable.push(`${sourceId}: ${baseline?.unavailableReason ?? "No reviewed fingerprint recorded"}; maintainer must review before --refresh-documents`);
          continue;
        }
        if (baseline.fingerprint.lastModified !== observed.fingerprint.lastModified ||
            baseline.fingerprint.etag !== observed.fingerprint.etag) {
          transportMetadataChanges.push({
            sourceId,
            recorded: { lastModified: baseline.fingerprint.lastModified, etag: baseline.fingerprint.etag },
            observed: { lastModified: observed.fingerprint.lastModified, etag: observed.fingerprint.etag },
          });
        }
        if (baseline.url !== observed.url || baseline.publisher !== observed.publisher ||
            baseline.fingerprint.contentHash !== observed.fingerprint.contentHash ||
            baseline.fingerprint.fileHash !== observed.fingerprint.fileHash ||
            baseline.fingerprint.revision !== observed.fingerprint.revision) {
          changed = true;
          const before = baseline.normalizedText ?? "";
          const after = observed.normalizedText ?? "";
          let offset = 0;
          while (offset < before.length && offset < after.length && before[offset] === after[offset]) offset++;
          differences.push({
            sourceId, firstDifferenceOffset: before === after ? null : offset,
            recordedExcerpt: before.slice(Math.max(0, offset - 100), offset + 300),
            observedExcerpt: after.slice(Math.max(0, offset - 100), offset + 300),
            recordedCharacters: before.length, observedCharacters: after.length,
          });
        }
      }
      const observed = { documents: evidence(fetched), differences, transportMetadataChanges };
      const baseline = evidence(recorded);
      // A detected change stays visible even when another cited document failed.
      if (changed) return { verdict: "changed", observed, recorded: baseline, reason: `Source fingerprint changed; review and diff the cited document. ${unavailable.join("; ")} ${reason}` };
      if (unavailable.length) return { verdict: "unavailable", observed, recorded: baseline, reason: `${unavailable.join("; ")}. ${reason}` };
      return { verdict: "holds", observed, recorded: baseline, reason: `Source substance and printed revision are unchanged; transport metadata is corroborating only${transportMetadataChanges.length ? " (Last-Modified/ETag drift is reported separately)" : ""}. The underlying condition was not re-decided. ${reason}` };
    },
  };
}

export function requireScenarioChain(context: ScenarioCheckContext, chainId = 1): ScenarioChainContext {
  const chain = context.chains[chainId];
  if (!chain) throw new Error(`Pinned read-only client unavailable for chain ${chainId}`);
  return chain;
}

export function scenarioSourceAddress(record: FailureScenario, sourceId: string): `0x${string}` {
  const source = record.sources.find((entry) => entry.id === sourceId);
  const address = source?.url.match(/0x[0-9a-fA-F]{40}/)?.[0];
  if (!address) throw new Error(`No recorded contract address for source ${sourceId}`);
  return address as `0x${string}`;
}

/** Registry is the CLI's selection and required-chain authority. */
export const FAILURE_SCENARIO_CHECKS: Readonly<Record<string, {
  chainIds: readonly number[];
  checks: readonly ScenarioCheck[];
}>> = {
  "crvusd-curve": { chainIds: [1], checks: crvusdChecks },
  "gho-aave": { chainIds: [1], checks: ghoChecks },
  "usdc-circle": { chainIds: [1], checks: usdcChecks },
  "usde-ethena": { chainIds: [1], checks: usdeChecks },
  "usds-sky": { chainIds: [1], checks: usdsChecks },
  "usdt-tether": { chainIds: [1], checks: usdtChecks },
  "usd1-world-liberty-financial": { chainIds: [1, 56], checks: usd1Checks },
  "lusd-liquity": { chainIds: [1], checks: lusdChecks },
};
