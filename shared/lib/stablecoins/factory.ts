import type { StablecoinMeta } from "../../types";

// Helper to reduce boilerplate
export interface StablecoinOpts {
  llamaId?: string;
  detailProvider?: "defillama" | "coingecko" | "commodity";
  yieldBearing?: boolean;
  rwa?: boolean;
  navToken?: boolean;
  collateral?: string;
  pegMechanism?: string;
  commodityOunces?: number;
  geckoId?: string;
  cmcSlug?: string;
  pythFeedId?: string;
  protocolSlug?: string;
  proofOfReserves?: StablecoinMeta["proofOfReserves"];
  links?: StablecoinMeta["links"];
  jurisdiction?: StablecoinMeta["jurisdiction"];
  contracts?: StablecoinMeta["contracts"];
  tradedContracts?: StablecoinMeta["tradedContracts"];
  dependencies?: StablecoinMeta["dependencies"];
  canBeBlacklisted?: boolean | "possible";
  chainTier?: StablecoinMeta["chainTier"];
  deploymentModel?: StablecoinMeta["deploymentModel"];
  collateralQuality?: StablecoinMeta["collateralQuality"];
  custodyModel?: StablecoinMeta["custodyModel"];
  governanceQuality?: StablecoinMeta["governanceQuality"];
  reserves?: StablecoinMeta["reserves"];
  liveReservesConfig?: StablecoinMeta["liveReservesConfig"];
  notices?: StablecoinMeta["notices"];
  tags?: string[];
  yieldConfig?: StablecoinMeta["yieldConfig"];
  status?: StablecoinMeta["status"];
  announcedDate?: string;
  expectedLaunchDate?: string;
  launchPhase?: StablecoinMeta["launchPhase"];
  launchPhaseDetail?: string;
}

export function coin(id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts): StablecoinMeta {
  return {
    id,
    name,
    symbol,
    flags: {
      backing,
      pegCurrency,
      governance,
      yieldBearing: opts?.yieldBearing ?? false,
      rwa: opts?.rwa ?? false,
      navToken: opts?.navToken ?? false,
    },
    collateral: opts?.collateral,
    pegMechanism: opts?.pegMechanism,
    commodityOunces: opts?.commodityOunces,
    llamaId: opts?.llamaId,
    detailProvider: opts?.detailProvider ?? "defillama",
    geckoId: opts?.geckoId,
    cmcSlug: opts?.cmcSlug,
    pythFeedId: opts?.pythFeedId,
    protocolSlug: opts?.protocolSlug,
    proofOfReserves: opts?.proofOfReserves,
    links: opts?.links,
    jurisdiction: opts?.jurisdiction,
    contracts: opts?.contracts,
    tradedContracts: opts?.tradedContracts,
    dependencies: opts?.dependencies,
    canBeBlacklisted: opts?.canBeBlacklisted,
    chainTier: opts?.chainTier,
    deploymentModel: opts?.deploymentModel,
    collateralQuality: opts?.collateralQuality,
    custodyModel: opts?.custodyModel,
    governanceQuality: opts?.governanceQuality,
    reserves: opts?.reserves,
    liveReservesConfig: opts?.liveReservesConfig,
    notices: opts?.notices,
    tags: opts?.tags,
    yieldConfig: opts?.yieldConfig,
    status: opts?.status,
    announcedDate: opts?.announcedDate,
    expectedLaunchDate: opts?.expectedLaunchDate,
    launchPhase: opts?.launchPhase,
    launchPhaseDetail: opts?.launchPhaseDetail,
  };
}
export const usd   = (id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts) => coin(id, name, symbol, backing, governance, "USD", opts);
export const eur   = (id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], opts?: StablecoinOpts) => coin(id, name, symbol, backing, governance, "EUR", opts);
export const other = (id: string, name: string, symbol: string, backing: StablecoinMeta["flags"]["backing"], governance: StablecoinMeta["flags"]["governance"], pegCurrency: StablecoinMeta["flags"]["pegCurrency"], opts?: StablecoinOpts) => coin(id, name, symbol, backing, governance, pegCurrency, opts);
