import { applyTrackedReviewedDocs, type RedemptionBackstopConfig } from "../shared";
import { AA_FALCONX_MEV_CAPITAL_STABLECOIN_REDEEM_CONFIG } from "./aa-falconx-mev-capital";
import { AID_GAIB_STABLECOIN_REDEEM_CONFIG } from "./aid-gaib";
import { APXUSD_APYX_STABLECOIN_REDEEM_CONFIG } from "./apxusd-apyx";
import { CUSDO_OPENEDEN_STABLECOIN_REDEEM_CONFIG } from "./cusdo-openeden";
import { DUSD_DTRINITY_STABLECOIN_REDEEM_CONFIG } from "./dusd-dtrinity";
import { FRXUSD_FRAX_STABLECOIN_REDEEM_CONFIG } from "./frxusd-frax";
import { FTUSD_FLYING_TULIP_STABLECOIN_REDEEM_CONFIG } from "./ftusd-flying-tulip";
import { FXSAVE_F_X_PROTOCOL_STABLECOIN_REDEEM_CONFIG } from "./fxsave-f-x-protocol";
import { GTUSDC_GAUNTLET_STABLECOIN_REDEEM_CONFIG } from "./gtusdc-gauntlet";
import { GTUSDCP_GAUNTLET_STABLECOIN_REDEEM_CONFIG } from "./gtusdcp-gauntlet";
import { JUPUSD_JUPITER_STABLECOIN_REDEEM_CONFIG } from "./jupusd-jupiter";
import { MSUSD_MAIN_STREET_STABLECOIN_REDEEM_CONFIG } from "./msusd-main-street";
import { MSY_MAIN_STREET_STABLECOIN_REDEEM_CONFIG } from "./msy-main-street";
import { OUSD_ORIGIN_PROTOCOL_STABLECOIN_REDEEM_CONFIG } from "./ousd-origin-protocol";
import { OUSG_ONDO_FINANCE_STABLECOIN_REDEEM_CONFIG } from "./ousg-ondo-finance";
import { PUSD_POLYMARKET_STABLECOIN_REDEEM_CONFIG } from "./pusd-polymarket";
import { SAID_GAIB_STABLECOIN_REDEEM_CONFIG } from "./said-gaib";
import { SBOLD_K3_CAPITAL_STABLECOIN_REDEEM_CONFIG } from "./sbold-k3-capital";
import { SCRVUSD_CURVE_STABLECOIN_REDEEM_CONFIG } from "./scrvusd-curve";
import { SDAI_SKY_STABLECOIN_REDEEM_CONFIG } from "./sdai-sky";
import { SDOLA_INVERSE_FINANCE_STABLECOIN_REDEEM_CONFIG } from "./sdola-inverse-finance";
import { SFRXUSD_FRAX_STABLECOIN_REDEEM_CONFIG } from "./sfrxusd-frax";
import { SGHO_AAVE_STABLECOIN_REDEEM_CONFIG } from "./sgho-aave";
import {
  REVIEWED_REMEDIATION_AT,
  REVIEWED_STABLECOIN_BATCH_AT,
} from "./shared";
import { SRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG } from "./srusd-reservoir";
import { STCUSD_CAP_STABLECOIN_REDEEM_CONFIG } from "./stcusd-cap";
import { STEAKUSDC_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG } from "./steakusdc-steakhouse";
import { STEAKUSDT_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG } from "./steakusdt-steakhouse";
import { STUSDS_SKY_STABLECOIN_REDEEM_CONFIG } from "./stusds-sky";
import { SUSDC_SPARK_STABLECOIN_REDEEM_CONFIG } from "./susdc-spark";
import { SUSDD_TRON_DAO_RESERVE_STABLECOIN_REDEEM_CONFIG } from "./susdd-tron-dao-reserve";
import { SUSD_SOLAYER_STABLECOIN_REDEEM_CONFIG } from "./susd-solayer";
import { SUSDS_SKY_STABLECOIN_REDEEM_CONFIG } from "./susds-sky";
import { SUSDT_SPARK_STABLECOIN_REDEEM_CONFIG } from "./susdt-spark";
import { SUSN_NOON_STABLECOIN_REDEEM_CONFIG } from "./susn-noon";
import { SYZUSD_YUZU_STABLECOIN_REDEEM_CONFIG } from "./syzusd-yuzu";
import { USD0_USUAL_STABLECOIN_REDEEM_CONFIG } from "./usd0-usual";
import { USDA_AVALON_STABLECOIN_REDEEM_CONFIG } from "./usda-avalon";
import { USDAI_USD_AI_STABLECOIN_REDEEM_CONFIG } from "./usdai-usd-ai";
import { USDB_BLAST_STABLECOIN_REDEEM_CONFIG } from "./usdb-blast";
import { USDCX_MOVEMENT_STABLECOIN_REDEEM_CONFIG } from "./usdcx-movement";
import { USDE_ETHENA_STABLECOIN_REDEEM_CONFIG } from "./usde-ethena";
import { USDF_ASTHERUS_STABLECOIN_REDEEM_CONFIG } from "./usdf-astherus";
import { USDSC_STARTALE_STABLECOIN_REDEEM_CONFIG } from "./usdsc-startale";
import { USDV_SOLOMON_STABLECOIN_REDEEM_CONFIG } from "./usdv-solomon";
import { USDZ_ANZEN_STABLECOIN_REDEEM_CONFIG } from "./usdz-anzen";
import { USN_NOON_STABLECOIN_REDEEM_CONFIG } from "./usn-noon";
import { USR_RESOLV_STABLECOIN_REDEEM_CONFIG } from "./usr-resolv";
import { USX_DFORCE_STABLECOIN_REDEEM_CONFIG } from "./usx-dforce";
import { USX_SOLSTICE_STABLECOIN_REDEEM_CONFIG } from "./usx-solstice";
import { U_UNITED_STABLES_STABLECOIN_REDEEM_CONFIG } from "./u-united-stables";
import { WEUSD_PICWE_STABLECOIN_REDEEM_CONFIG } from "./weusd-picwe";
import { WM_M0_STABLECOIN_REDEEM_CONFIG } from "./wm-m0";
import { WSRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG } from "./wsrusd-reservoir";
import { XDAI_GNOSIS_STABLECOIN_REDEEM_CONFIG } from "./xdai-gnosis";
import { YBOLD_YEARN_STABLECOIN_REDEEM_CONFIG } from "./ybold-yearn";
import { YOUSD_YIELD_OPTIMIZER_STABLECOIN_REDEEM_CONFIG } from "./yousd-yield-optimizer";
import { YUSD_AEGIS_STABLECOIN_REDEEM_CONFIG } from "./yusd-aegis";
import { YUSD_YIELDFI_STABLECOIN_REDEEM_CONFIG } from "./yusd-yieldfi";
import { YVUSDC_YEARN_STABLECOIN_REDEEM_CONFIG } from "./yvusdc-yearn";
import { ZCHF_FRANKENCOIN_STABLECOIN_REDEEM_CONFIG } from "./zchf-frankencoin";
import { ZYS_ZEPHYR_PROTOCOL_STABLECOIN_REDEEM_CONFIG } from "./zys-zephyr-protocol";

export const STABLECOIN_REDEEM_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "dusd-dtrinity": DUSD_DTRINITY_STABLECOIN_REDEEM_CONFIG,
  "ousd-origin-protocol": OUSD_ORIGIN_PROTOCOL_STABLECOIN_REDEEM_CONFIG,
  "ousg-ondo-finance": OUSG_ONDO_FINANCE_STABLECOIN_REDEEM_CONFIG,
  "usde-ethena": USDE_ETHENA_STABLECOIN_REDEEM_CONFIG,
  "zchf-frankencoin": ZCHF_FRANKENCOIN_STABLECOIN_REDEEM_CONFIG,
  "yousd-yield-optimizer": YOUSD_YIELD_OPTIMIZER_STABLECOIN_REDEEM_CONFIG,
  "wsrusd-reservoir": WSRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG,
  "susds-sky": SUSDS_SKY_STABLECOIN_REDEEM_CONFIG,
  "sdai-sky": SDAI_SKY_STABLECOIN_REDEEM_CONFIG,
  "sdola-inverse-finance": SDOLA_INVERSE_FINANCE_STABLECOIN_REDEEM_CONFIG,
  "sfrxusd-frax": SFRXUSD_FRAX_STABLECOIN_REDEEM_CONFIG,
  "scrvusd-curve": SCRVUSD_CURVE_STABLECOIN_REDEEM_CONFIG,
  "cusdo-openeden": CUSDO_OPENEDEN_STABLECOIN_REDEEM_CONFIG,
  "usdf-astherus": USDF_ASTHERUS_STABLECOIN_REDEEM_CONFIG,
  "usr-resolv": USR_RESOLV_STABLECOIN_REDEEM_CONFIG,
  "yusd-aegis": YUSD_AEGIS_STABLECOIN_REDEEM_CONFIG,
  "usn-noon": USN_NOON_STABLECOIN_REDEEM_CONFIG,
  "aid-gaib": AID_GAIB_STABLECOIN_REDEEM_CONFIG,
  "u-united-stables": U_UNITED_STABLES_STABLECOIN_REDEEM_CONFIG,
  "usx-solstice": USX_SOLSTICE_STABLECOIN_REDEEM_CONFIG,
  "usda-avalon": USDA_AVALON_STABLECOIN_REDEEM_CONFIG,
  "usd0-usual": USD0_USUAL_STABLECOIN_REDEEM_CONFIG,
  "usdai-usd-ai": USDAI_USD_AI_STABLECOIN_REDEEM_CONFIG,
  "frxusd-frax": FRXUSD_FRAX_STABLECOIN_REDEEM_CONFIG,
  "jupusd-jupiter": JUPUSD_JUPITER_STABLECOIN_REDEEM_CONFIG,
  "msusd-main-street": MSUSD_MAIN_STREET_STABLECOIN_REDEEM_CONFIG,
  "wm-m0": WM_M0_STABLECOIN_REDEEM_CONFIG,
  "ftusd-flying-tulip": FTUSD_FLYING_TULIP_STABLECOIN_REDEEM_CONFIG,
  "usdz-anzen": USDZ_ANZEN_STABLECOIN_REDEEM_CONFIG,
  "usdsc-startale": USDSC_STARTALE_STABLECOIN_REDEEM_CONFIG,
  "apxusd-apyx": APXUSD_APYX_STABLECOIN_REDEEM_CONFIG,
  "pusd-polymarket": PUSD_POLYMARKET_STABLECOIN_REDEEM_CONFIG,
  "susd-solayer": SUSD_SOLAYER_STABLECOIN_REDEEM_CONFIG,
  "usx-dforce": USX_DFORCE_STABLECOIN_REDEEM_CONFIG,
  "xdai-gnosis": XDAI_GNOSIS_STABLECOIN_REDEEM_CONFIG,
  "susdd-tron-dao-reserve": SUSDD_TRON_DAO_RESERVE_STABLECOIN_REDEEM_CONFIG,
  "srusd-reservoir": SRUSD_RESERVOIR_STABLECOIN_REDEEM_CONFIG,
  "steakusdc-steakhouse": STEAKUSDC_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG,
  "steakusdt-steakhouse": STEAKUSDT_STEAKHOUSE_STABLECOIN_REDEEM_CONFIG,
  "syzusd-yuzu": SYZUSD_YUZU_STABLECOIN_REDEEM_CONFIG,
  "fxsave-f-x-protocol": FXSAVE_F_X_PROTOCOL_STABLECOIN_REDEEM_CONFIG,
  "susn-noon": SUSN_NOON_STABLECOIN_REDEEM_CONFIG,
  "usdcx-movement": USDCX_MOVEMENT_STABLECOIN_REDEEM_CONFIG,
  "susdt-spark": SUSDT_SPARK_STABLECOIN_REDEEM_CONFIG,
  "susdc-spark": SUSDC_SPARK_STABLECOIN_REDEEM_CONFIG,
  "gtusdc-gauntlet": GTUSDC_GAUNTLET_STABLECOIN_REDEEM_CONFIG,
  "gtusdcp-gauntlet": GTUSDCP_GAUNTLET_STABLECOIN_REDEEM_CONFIG,
  "yvusdc-yearn": YVUSDC_YEARN_STABLECOIN_REDEEM_CONFIG,
  "sgho-aave": SGHO_AAVE_STABLECOIN_REDEEM_CONFIG,
  "stusds-sky": STUSDS_SKY_STABLECOIN_REDEEM_CONFIG,
  "stcusd-cap": STCUSD_CAP_STABLECOIN_REDEEM_CONFIG,
  "sbold-k3-capital": SBOLD_K3_CAPITAL_STABLECOIN_REDEEM_CONFIG,
  "ybold-yearn": YBOLD_YEARN_STABLECOIN_REDEEM_CONFIG,
  "msy-main-street": MSY_MAIN_STREET_STABLECOIN_REDEEM_CONFIG,
  "yusd-yieldfi": YUSD_YIELDFI_STABLECOIN_REDEEM_CONFIG,
  "said-gaib": SAID_GAIB_STABLECOIN_REDEEM_CONFIG,
  "zys-zephyr-protocol": ZYS_ZEPHYR_PROTOCOL_STABLECOIN_REDEEM_CONFIG,
  "aa-falconx-mev-capital": AA_FALCONX_MEV_CAPITAL_STABLECOIN_REDEEM_CONFIG,
  "usdb-blast": USDB_BLAST_STABLECOIN_REDEEM_CONFIG,
  "usdv-solomon": USDV_SOLOMON_STABLECOIN_REDEEM_CONFIG,
  "weusd-picwe": WEUSD_PICWE_STABLECOIN_REDEEM_CONFIG,
};

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, ["ousg-ondo-finance", "u-united-stables", "usd0-usual"]);

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, ["dusd-dtrinity", "yousd-yield-optimizer"], REVIEWED_REMEDIATION_AT);

applyTrackedReviewedDocs(STABLECOIN_REDEEM_BACKSTOP_CONFIGS, [
  "pusd-polymarket",
  "susd-solayer",
  "usx-dforce",
  "xdai-gnosis",
], REVIEWED_STABLECOIN_BATCH_AT);
