import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MintAuthorityControl,
  MintAuthorityProfile,
  MintAuthorityUpgradeModel,
  StablecoinLink,
} from "../../shared/types/core";

interface UpgradeBackfill {
  model: MintAuthorityUpgradeModel;
  controlRef: string;
  delaySec?: number;
  observedBlock?: number;
}

const BACKFILLS: Record<string, UpgradeBackfill> = {
  "aeur-anchored-coins": {
    model: "transparent-proxy",
    controlRef: "AEUR proxy admin",
  },
  "alusd-alchemix": {
    model: "transparent-proxy",
    controlRef: "Alchemix Gnosis Safe (ADMIN_ROLE + ProxyAdmin owner)",
    observedBlock: 25_295_217,
  },
  "buck-bucket-protocol": {
    model: "custom",
    controlRef: "Bucket package upgrade-cap owner (EOA)",
    observedBlock: 285_785_957,
  },
  "ebusd-ebisu": {
    model: "custom",
    controlRef: "Ebisu Gnosis Safe (EbisuUpgradeable admin, 7-day timelock)",
    delaySec: 604_800,
    observedBlock: 25_295_272,
  },
  "eur0-usual": {
    model: "transparent-proxy",
    controlRef: "EUR0 ProxyAdmin (owned by Usual 8/15 Safe)",
    observedBlock: 25_295_183,
  },
  "euri-banking-circle": {
    model: "transparent-proxy",
    controlRef: "EURI EIP-1967 proxy admin (Ethereum and BSC)",
  },
  "eurq-quantoz": {
    model: "transparent-proxy",
    controlRef: "EURQ Ethereum EIP-1967 proxy admin",
  },
  "eurr-stablr": {
    model: "transparent-proxy",
    controlRef: "EURR EIP-1967 proxy admin",
    observedBlock: 25_166_592,
  },
  "fusd-finchain": {
    model: "transparent-proxy",
    controlRef: "FUSD ProxyAdmin (upgrade authority, EOA-owned)",
  },
  "gldt-gold-dao": {
    model: "custom",
    controlRef: "Gold DAO SNS governance (canister controller)",
  },
  "gyen-gyen": {
    model: "transparent-proxy",
    controlRef: "GYEN EIP-1967 proxy admin",
    observedBlock: 25_295_183,
  },
  "lisusd-lista": {
    model: "transparent-proxy",
    controlRef: "LISUSD EIP-1967 proxy admin (owned by timelock)",
    observedBlock: 103_622_030,
  },
  "pgold-pleasing": {
    model: "transparent-proxy",
    controlRef: "Proxy-admin upgrade authority — Arbitrum",
    observedBlock: 472_413_865,
  },
  "qcad-stablecorp": {
    model: "transparent-proxy",
    controlRef: "Proxy-admin upgrade authority — Ethereum and Base",
  },
  "sbc-brale": {
    model: "uups",
    controlRef: "Proxy upgrade authority — 6-signer legacy multisig, threshold 3 (UPGRADER_ROLE)",
    observedBlock: 25_295_066,
  },
  "susd-solayer": {
    model: "custom",
    controlRef: "Solayer sUSD program upgrade authority",
    observedBlock: 425_792_161,
  },
  "usdq-quantoz": {
    model: "transparent-proxy",
    controlRef: "USDQ Ethereum proxy admin",
  },
  "usdq-quill": {
    model: "uups",
    controlRef: "QuillAccessManager (UUPS proxy, admin = Quill Safe multisig)",
    observedBlock: 34_053_392,
  },
  "usdr-stablr": {
    model: "transparent-proxy",
    controlRef: "USDR EIP-1967 proxy admin",
    observedBlock: 25_294_990,
  },
  "usx-solstice": {
    model: "custom",
    controlRef: "Solstice USX program upgrade authority (EOA)",
    observedBlock: 425_778_559,
  },
  "uusd-anything-labs": {
    model: "transparent-proxy",
    controlRef: "UUSD proxy-admin ownership chain",
    observedBlock: 103_627_514,
  },
  "vgbp-vnx": {
    model: "transparent-proxy",
    controlRef: "VGBP proxy admin contract",
  },
  "wusd-worldwide": {
    model: "uups",
    controlRef: "WUSD Viction UPGRADER_ROLE + CONTRACT_ADMIN_ROLE holder",
    observedBlock: 109_908_880,
  },
};

function sourceFile(id: string): string {
  const sidecar = resolve(import.meta.dirname, `../../shared/data/stablecoins/domains/mint-authority/${id}.json`);
  try {
    readFileSync(sidecar, "utf8");
    return sidecar;
  } catch {
    return resolve(import.meta.dirname, `../../shared/data/stablecoins/coins/${id}.json`);
  }
}

function uniqueSources(...groups: Array<StablecoinLink[] | undefined>): StablecoinLink[] {
  return [...new Map(groups.flatMap((group) => group ?? []).map((source) => [source.url, source])).values()];
}

function referencedControls(profile: MintAuthorityProfile, controlRef: string): MintAuthorityControl[] {
  const controls = profile.controls?.filter((control) => control.directMintAbility === "upgrade-only") ?? [];
  if (!controls.some((control) => control.label === controlRef)) {
    throw new Error(`upgrade control ${controlRef} is missing`);
  }
  return controls;
}

let backfilled = 0;
for (const [id, backfill] of Object.entries(BACKFILLS)) {
  const file = sourceFile(id);
  const source = JSON.parse(readFileSync(file, "utf8")) as { mintAuthority?: MintAuthorityProfile };
  const profile = source.mintAuthority;
  if (!profile) throw new Error(`${id} has no mintAuthority profile in ${file}`);
  if (profile.upgradeability) continue;

  const controls = referencedControls(profile, backfill.controlRef);
  const adminAddresses = controls.flatMap((control) => (control.address ? [control.address] : []));
  const sources = uniqueSources(...controls.map((control) => control.sources), profile.review.sources);
  if (sources.length === 0) throw new Error(`${id} upgrade record has no reviewed source`);

  profile.upgradeability = {
    model: backfill.model,
    ...(adminAddresses.length > 0 ? { adminAddresses: [...new Set(adminAddresses)] } : {}),
    canChangeMintLogic: true,
    ...(backfill.delaySec != null ? { delaySec: backfill.delaySec } : {}),
    controlRef: backfill.controlRef,
    observedAt: profile.review.reviewedAt,
    ...(backfill.observedBlock != null ? { observedBlock: backfill.observedBlock } : {}),
    sources,
  };

  writeFileSync(file, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  backfilled += 1;
}

process.stdout.write(`Backfilled ${backfilled} reviewed upgradeability records.\n`);
