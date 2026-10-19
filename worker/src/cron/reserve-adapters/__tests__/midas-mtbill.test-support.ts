import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import capture from "./fixtures/midas-mtbill-save.json";
import type { AdapterNetworkSpec, AdapterRpcValue } from "./reserve-adapter.test-support";

export const MIDAS_CAPTURE_NOW = Number.parseInt(capture.block.timestamp, 16);
export const MIDAS_CHECKPOINT_SEC = Date.parse("2026-10-16T10:00:00Z") / 1000;
export type MidasTestDocument = typeof capture.attestation;
export interface MidasNetworkOptions {
  document?: MidasTestDocument;
  preserveSignedData?: boolean;
  historical?: unknown;
  file?: Uint8Array;
  rpc?: Record<string, AdapterRpcValue>;
  hash?: `0x${string}`;
}

export function midasClaimData(document: MidasTestDocument, id: string): Record<string, unknown> {
  const row = document.claims.find((claim) => claim.id === id);
  if (!row?.data) throw new Error(`Missing object fixture claim ${id}`);
  return row.data;
}

// Independent fixture encoder: the recorded CID/root is the positive test oracle.
// Synthetic documents exercise decoder failures after valid registry/CID binding;
// they are never presented as issuer-signed public captures.
function fixtureUnixfsDigest(file: Uint8Array): `0x${string}` {
  const variable = (n: number): Buffer => {
    const bytes = [];
    do { bytes.push((n & 127) | (n >= 128 ? 128 : 0)); n = Math.floor(n / 128); } while (n);
    return Buffer.from(bytes);
  };
  const unixfs = Buffer.concat([Buffer.from([8, 2, 18]), variable(file.length), file, Buffer.from([24]), variable(file.length)]);
  const pbNode = Buffer.concat([Buffer.from([10]), variable(unixfs.length), unixfs]);
  return `0x${createHash("sha256").update(pbNode).digest("hex")}`;
}

export function midasNetwork(options: MidasNetworkOptions = {}): AdapterNetworkSpec {
  let file = Buffer.from(capture.gzipBase64, "base64");
  if (options.document) {
    const document = structuredClone(options.document);
    if (!options.preserveSignedData) document.signature.signedData = `0x${createHash("sha256").update(stableJsonStringifyV1({ metadata: document.metadata, claims: document.claims })).digest("hex")}`;
    file = gzipSync(JSON.stringify(document));
  }
  if (options.file) file = Buffer.from(options.file);
  const hash = options.hash ?? fixtureUnixfsDigest(file);
  let number = BigInt(`0x1220${hash.slice(2)}`);
  let cid = "";
  while (number > 0n) { cid = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Number(number % 58n)] + cid; number /= 58n; }
  const publishedAt = Number.parseInt(capture.registryResponses["proofIdToLatestAttestation(bytes32)"].slice(-64), 16);
  const publisher = `0x${capture.registryResponses["proofIdToAuthorizedAttestor(bytes32)"].slice(-40)}` as const;
  const documentReport = options.document?.claims.find((row) => row.id === "onetoken_report");
  const metadata = (documentReport?.data?._metadata ?? midasClaimData(capture.attestation, "onetoken_report")._metadata) as Record<string, unknown>;
  const url = `https://api-prod.midas.app/api/transparency/by-timestamp?token=mTBILL&timestamp=${encodeURIComponent(String(metadata.timestamp))}`;
  return {
    block: { number: Number.parseInt(capture.block.number, 16), timestamp: MIDAS_CAPTURE_NOW, hash: capture.block.hash },
    rpc: {
      [`${capture.registry}:proofIdToLatestAttestation(bytes32)`]: encodeAbiParameters(parseAbiParameters("bytes32, address, uint48"), [hash, publisher, publishedAt]),
      [`${capture.registry}:proofIdToAuthorizedAttestor(bytes32)`]: capture.registryResponses["proofIdToAuthorizedAttestor(bytes32)"],
      [`${capture.registry}:proofIdToName(bytes32)`]: capture.registryResponses["proofIdToName(bytes32)"],
      [`${capture.registry}:proofExists(bytes32)`]: capture.registryResponses["proofExists(bytes32)"],
      ...options.rpc,
    },
    json: {
      [`https://gateway.pinata.cloud/ipfs/${cid}`]: () => new Response(new Uint8Array(file), { headers: { "content-type": "application/gzip" } }),
      [url]: options.historical ?? JSON.parse(capture.historicalBody),
    },
  };
}
