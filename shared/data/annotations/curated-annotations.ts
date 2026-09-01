/**
 * Typed runtime loader for the per-coin curated annotation assets.
 *
 * The JSON files are the editorial source of truth. This module keeps the
 * existing runtime API while converting authoring dates to Unix milliseconds
 * and validating the corpus at module initialization. Editorial notes remain
 * in the JSON assets and are intentionally not added to runtime annotations.
 */
import canonicalOrderAsset from "../stablecoins/canonical-order.json";
import {
  CHART_ANNOTATION_KINDS,
  type ChartAnnotation,
  type ChartAnnotationKind,
} from "@shared/types/chart-annotation";
import source0 from "./coins/usdc-circle.json";
import source1 from "./coins/usdt-tether.json";
import source2 from "./coins/dai-makerdao.json";
import source3 from "./coins/usde-ethena.json";
import source4 from "./coins/usds-sky.json";
import source5 from "./coins/usd1-world-liberty-financial.json";
import source6 from "./coins/pyusd-paypal.json";
import source7 from "./coins/buidl-blackrock.json";
import source8 from "./coins/usyc-hashnote.json";
import source9 from "./coins/usdg-paxos.json";
import source10 from "./coins/usdy-ondo-finance.json";
import source11 from "./coins/usdf-falcon.json";
import source12 from "./coins/rlusd-ripple.json";
import source13 from "./coins/usdd-tron-dao-reserve.json";
import source14 from "./coins/usdtb-ethena.json";
import source15 from "./coins/u-united-stables.json";
import source16 from "./coins/gho-aave.json";
import source17 from "./coins/a7a5-old-vector.json";
import source18 from "./coins/usd0-usual.json";
import source19 from "./coins/ylds-figure.json";
import source20 from "./coins/tusd-trueusd.json";
import source21 from "./coins/eurc-circle.json";
import source22 from "./coins/usdgo-osl.json";
import source23 from "./coins/fdusd-first-digital.json";
import source24 from "./coins/usx-solstice.json";
import source25 from "./coins/brz-transfero.json";
import source26 from "./coins/m-m0.json";
import source27 from "./coins/usdm-moneta.json";
import source28 from "./coins/usdm-mega.json";
import source29 from "./coins/usda-avalon.json";
import source30 from "./coins/crvusd-curve.json";
import source31 from "./coins/frax-frax.json";
import source32 from "./coins/reusd-re-protocol.json";
import source33 from "./coins/gusd-gate.json";
import source34 from "./coins/satusd-river.json";
import source35 from "./coins/usat-tether.json";
import source36 from "./coins/ausd-agora.json";
import source37 from "./coins/nusd-nexus.json";
import source38 from "./coins/nusd-neutrl.json";
import source39 from "./coins/frxusd-frax.json";
import source40 from "./coins/cusd-cap.json";
import source41 from "./coins/tbill-openeden.json";
import source42 from "./coins/cash-phantom.json";
import source43 from "./coins/moveusd-cfx.json";
import source44 from "./coins/usdf-astherus.json";
import source45 from "./coins/dusd-standx.json";
import source46 from "./coins/dusd-fluid.json";
import source47 from "./coins/fpi-frax.json";
import source48 from "./coins/cadd-cad-digital.json";
import source49 from "./coins/aeur-anchored-coins.json";
import source50 from "./coins/alusd-alchemix.json";
import source51 from "./coins/bnusd-balanced.json";
import source52 from "./coins/bold-liquity.json";
import source53 from "./coins/brl1-brl1.json";
import source54 from "./coins/brla-brla-digital.json";
import source55 from "./coins/btcusd-btcfi.json";
import source56 from "./coins/buck-bucket-protocol.json";
import source57 from "./coins/busd0-usual.json";
import source58 from "./coins/cadc-cad-coin.json";
import source59 from "./coins/cdp-enosys.json";
import source60 from "./coins/cetes-etherfuse.json";
import source61 from "./coins/chfau-allunity.json";
import source62 from "./coins/cjpy-yamato.json";
import source63 from "./coins/cngn-compliant-naira.json";
import source64 from "./coins/ctusd-citrea.json";
import source65 from "./coins/cusdo-openeden.json";
import source66 from "./coins/deuro-deuro.json";
import source67 from "./coins/dgld-gold-token-sa.json";
import source68 from "./coins/djed-coti.json";
import source69 from "./coins/dllr-sovryn.json";
import source70 from "./coins/doc-money-on-chain.json";
import source71 from "./coins/dola-inverse-finance.json";
import source72 from "./coins/dusd-dtrinity.json";
import source73 from "./coins/sdusd-dtrinity.json";
import source74 from "./coins/eurau-allunity.json";
import source75 from "./coins/eurcv-societe-generale-forge.json";
import source76 from "./coins/eure-monerium.json";
import source77 from "./coins/euri-banking-circle.json";
import source78 from "./coins/euroe-membrane.json";
import source79 from "./coins/europ-schuman.json";
import source80 from "./coins/eurq-quantoz.json";
import source81 from "./coins/eurr-stablr.json";
import source82 from "./coins/eurs-stasis.json";
import source83 from "./coins/eusd-telcoin.json";
import source84 from "./coins/eutbl-spiko.json";
import source85 from "./coins/feusd-felix.json";
import source86 from "./coins/fidd-fidelity.json";
import source87 from "./coins/fiusd-fiserv.json";
import source88 from "./coins/ftusd-flying-tulip.json";
import source89 from "./coins/fusd-freedom-dollar.json";
import source90 from "./coins/fxusd-f-x-protocol.json";
import source91 from "./coins/gusd-gemini.json";
import source92 from "./coins/gyen-gyen.json";
import source93 from "./coins/hkdap-anchorpoint.json";
import source94 from "./coins/hkd-hsbc.json";
import source95 from "./coins/hkdr-rd-technologies.json";
import source96 from "./coins/hlscope-hamilton-lane.json";
import source97 from "./coins/honey-berachain.json";
import source98 from "./coins/ist-agoric.json";
import source99 from "./coins/iusd-indigo-protocol.json";
import source100 from "./coins/jaaa-janus-henderson-anemoy.json";
import source101 from "./coins/jpyc-jpyc.json";
import source102 from "./coins/jupusd-jupiter.json";
import source103 from "./coins/kgst-kyrgyz-som.json";
import source104 from "./coins/klarnausd-klarna.json";
import source105 from "./coins/krw1-bdacs.json";
import source106 from "./coins/lisusd-lista.json";
import source107 from "./coins/lusd-liquity.json";
import source108 from "./coins/mai-qidao.json";
import source109 from "./coins/meusd-mezo.json";
import source110 from "./coins/mim-abracadabra.json";
import source111 from "./coins/musd-metamask.json";
import source112 from "./coins/mxnb-juno.json";
import source113 from "./coins/nect-beraborrow.json";
import source114 from "./coins/ousd-origin-protocol.json";
import source115 from "./coins/ousg-ondo-finance.json";
import source116 from "./coins/paxg-paxos.json";
import source117 from "./coins/pusd-polaris.json";
import source118 from "./coins/reusd-resupply.json";
import source119 from "./coins/susd-synthetix.json";
import source120 from "./coins/usdb-blast.json";
import source121 from "./coins/usdcv-societe-generale-forge.json";
import source122 from "./coins/usdh-native-markets.json";
import source123 from "./coins/usdn-noble.json";
import source124 from "./coins/usdp-paxos.json";
import source125 from "./coins/usdpt-western-union.json";
import source126 from "./coins/usdq-quantoz.json";
import source127 from "./coins/usdr-stablr.json";
import source128 from "./coins/usdsui-sui.json";
import source129 from "./coins/usdx-kava.json";
import source130 from "./coins/ustb-superstate.json";
import source131 from "./coins/usx-dforce.json";
import source132 from "./coins/wemix-dollar-wemix.json";
import source133 from "./coins/wusd-worldwide.json";
import source134 from "./coins/xdai-gnosis.json";
import source135 from "./coins/xusd-babelfish.json";
import source136 from "./coins/yousd-yield-optimizer.json";
import source137 from "./coins/apxusd-apyx.json";
import source138 from "./coins/cusd-celo.json";
import source139 from "./coins/jtrsy-anemoy.json";
import source140 from "./coins/kag-kinesis.json";
import source141 from "./coins/kau-kinesis.json";
import source142 from "./coins/safo-spiko-usd.json";
import source143 from "./coins/silk-shade-protocol.json";
import source144 from "./coins/sofid-sofi.json";
import source145 from "./coins/spkcc-spiko.json";
import source146 from "./coins/trusd-tori.json";
import source147 from "./coins/bd-basedollar.json";
import source148 from "./coins/kusd-kerne.json";
import source149 from "./coins/usr-resolv.json";
import source150 from "./coins/zeusd-zoth.json";
import source151 from "./coins/idrt-rupiah-token.json";

type CuratedAnnotationSource = Readonly<Record<string, unknown>>;
type CuratedAnnotationSourceAsset = readonly CuratedAnnotationSource[];

const CURATED_SOURCES: Readonly<Record<string, CuratedAnnotationSourceAsset>> = {
  "usdc-circle": source0,
  "usdt-tether": source1,
  "dai-makerdao": source2,
  "usde-ethena": source3,
  "usds-sky": source4,
  "usd1-world-liberty-financial": source5,
  "pyusd-paypal": source6,
  "buidl-blackrock": source7,
  "usyc-hashnote": source8,
  "usdg-paxos": source9,
  "usdy-ondo-finance": source10,
  "usdf-falcon": source11,
  "rlusd-ripple": source12,
  "usdd-tron-dao-reserve": source13,
  "usdtb-ethena": source14,
  "u-united-stables": source15,
  "gho-aave": source16,
  "a7a5-old-vector": source17,
  "usd0-usual": source18,
  "ylds-figure": source19,
  "tusd-trueusd": source20,
  "eurc-circle": source21,
  "usdgo-osl": source22,
  "fdusd-first-digital": source23,
  "usx-solstice": source24,
  "brz-transfero": source25,
  "m-m0": source26,
  "usdm-moneta": source27,
  "usdm-mega": source28,
  "usda-avalon": source29,
  "crvusd-curve": source30,
  "frax-frax": source31,
  "reusd-re-protocol": source32,
  "gusd-gate": source33,
  "satusd-river": source34,
  "usat-tether": source35,
  "ausd-agora": source36,
  "nusd-nexus": source37,
  "nusd-neutrl": source38,
  "frxusd-frax": source39,
  "cusd-cap": source40,
  "tbill-openeden": source41,
  "cash-phantom": source42,
  "moveusd-cfx": source43,
  "usdf-astherus": source44,
  "dusd-standx": source45,
  "dusd-fluid": source46,
  "fpi-frax": source47,
  "cadd-cad-digital": source48,
  "aeur-anchored-coins": source49,
  "alusd-alchemix": source50,
  "bnusd-balanced": source51,
  "bold-liquity": source52,
  "brl1-brl1": source53,
  "brla-brla-digital": source54,
  "btcusd-btcfi": source55,
  "buck-bucket-protocol": source56,
  "busd0-usual": source57,
  "cadc-cad-coin": source58,
  "cdp-enosys": source59,
  "cetes-etherfuse": source60,
  "chfau-allunity": source61,
  "cjpy-yamato": source62,
  "cngn-compliant-naira": source63,
  "ctusd-citrea": source64,
  "cusdo-openeden": source65,
  "deuro-deuro": source66,
  "dgld-gold-token-sa": source67,
  "djed-coti": source68,
  "dllr-sovryn": source69,
  "doc-money-on-chain": source70,
  "dola-inverse-finance": source71,
  "dusd-dtrinity": source72,
  "sdusd-dtrinity": source73,
  "eurau-allunity": source74,
  "eurcv-societe-generale-forge": source75,
  "eure-monerium": source76,
  "euri-banking-circle": source77,
  "euroe-membrane": source78,
  "europ-schuman": source79,
  "eurq-quantoz": source80,
  "eurr-stablr": source81,
  "eurs-stasis": source82,
  "eusd-telcoin": source83,
  "eutbl-spiko": source84,
  "feusd-felix": source85,
  "fidd-fidelity": source86,
  "fiusd-fiserv": source87,
  "ftusd-flying-tulip": source88,
  "fusd-freedom-dollar": source89,
  "fxusd-f-x-protocol": source90,
  "gusd-gemini": source91,
  "gyen-gyen": source92,
  "hkdap-anchorpoint": source93,
  "hkd-hsbc": source94,
  "hkdr-rd-technologies": source95,
  "hlscope-hamilton-lane": source96,
  "honey-berachain": source97,
  "ist-agoric": source98,
  "iusd-indigo-protocol": source99,
  "jaaa-janus-henderson-anemoy": source100,
  "jpyc-jpyc": source101,
  "jupusd-jupiter": source102,
  "kgst-kyrgyz-som": source103,
  "klarnausd-klarna": source104,
  "krw1-bdacs": source105,
  "lisusd-lista": source106,
  "lusd-liquity": source107,
  "mai-qidao": source108,
  "meusd-mezo": source109,
  "mim-abracadabra": source110,
  "musd-metamask": source111,
  "mxnb-juno": source112,
  "nect-beraborrow": source113,
  "ousd-origin-protocol": source114,
  "ousg-ondo-finance": source115,
  "paxg-paxos": source116,
  "pusd-polaris": source117,
  "reusd-resupply": source118,
  "susd-synthetix": source119,
  "usdb-blast": source120,
  "usdcv-societe-generale-forge": source121,
  "usdh-native-markets": source122,
  "usdn-noble": source123,
  "usdp-paxos": source124,
  "usdpt-western-union": source125,
  "usdq-quantoz": source126,
  "usdr-stablr": source127,
  "usdsui-sui": source128,
  "usdx-kava": source129,
  "ustb-superstate": source130,
  "usx-dforce": source131,
  "wemix-dollar-wemix": source132,
  "wusd-worldwide": source133,
  "xdai-gnosis": source134,
  "xusd-babelfish": source135,
  "yousd-yield-optimizer": source136,
  "apxusd-apyx": source137,
  "cusd-celo": source138,
  "jtrsy-anemoy": source139,
  "kag-kinesis": source140,
  "kau-kinesis": source141,
  "safo-spiko-usd": source142,
  "silk-shade-protocol": source143,
  "sofid-sofi": source144,
  "spkcc-spiko": source145,
  "trusd-tori": source146,
  "bd-basedollar": source147,
  "kusd-kerne": source148,
  "usr-resolv": source149,
  "zeusd-zoth": source150,
  "idrt-rupiah-token": source151,
};

const KNOWN_STABLECOIN_IDS = new Set(canonicalOrderAsset as readonly string[]);
const ALLOWED_KINDS = new Set<string>(CHART_ANNOTATION_KINDS);
const ALLOWED_SEVERITIES = new Set(["low", "med", "high"]);
const ALLOWED_FIELDS = new Set(["date", "kind", "label", "severity", "href", "note"]);
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored fixed-shape ISO timestamp; finite quantifiers, no backtracking ambiguity.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function invalid(coinId: string, index: number, message: string): never {
  throw new Error('Invalid curated annotation ' + coinId + '[' + index + ']: ' + message);
}

function isRecord(value: unknown): value is CuratedAnnotationSource {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTimestamp(value: unknown, coinId: string, index: number): number {
  if (typeof value !== "string") invalid(coinId, index, "date must be an ISO string");
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) {
    const timestamp = Date.UTC(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
    );
    if (
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== value
    ) {
      invalid(coinId, index, "date is not a valid calendar date");
    }
    return timestamp;
  }
  if (!ISO_UTC_RE.test(value)) {
    invalid(coinId, index, "date must be YYYY-MM-DD or a full UTC ISO timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalid(coinId, index, "date is invalid");
  return timestamp;
}

function resolveAnnotation(
  raw: unknown,
  coinId: string,
  index: number,
): ChartAnnotation {
  if (!isRecord(raw)) invalid(coinId, index, "entry must be an object");
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(field)) invalid(coinId, index, 'unknown field "' + field + '"');
  }

  const date = toTimestamp(raw.date, coinId, index);
  const kind = raw.kind;
  const label = raw.label;
  const severity = raw.severity;
  const href = raw.href;
  const note = raw.note;
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind)) {
    invalid(coinId, index, "kind is not in CHART_ANNOTATION_KINDS");
  }
  if (
    typeof label !== "string" ||
    label.length === 0 ||
    label.length > 80
  ) {
    invalid(coinId, index, "label must be a non-empty string of at most 80 characters");
  }
  if (
    severity !== undefined &&
    (typeof severity !== "string" || !ALLOWED_SEVERITIES.has(severity))
  ) {
    invalid(coinId, index, "severity must be low, med, or high");
  }
  if (href !== undefined && (typeof href !== "string" || href.length === 0)) {
    invalid(coinId, index, "href must be a non-empty string when present");
  }
  if (note !== undefined && (typeof note !== "string" || note.length === 0)) {
    invalid(coinId, index, "note must be a non-empty string when present");
  }

  return {
    ts: date,
    kind: kind as ChartAnnotationKind,
    label: label as string,
    ...(severity !== undefined
      ? { severity: severity as ChartAnnotation["severity"] }
      : {}),
    ...(href !== undefined ? { href: href as string } : {}),
  };
}

function buildCuratedAnnotations(): Record<string, readonly ChartAnnotation[]> {
  const result: Record<string, readonly ChartAnnotation[]> = {};
  for (const [coinId, source] of Object.entries(CURATED_SOURCES)) {
    if (!KNOWN_STABLECOIN_IDS.has(coinId)) {
      throw new Error("Curated annotations reference unknown stablecoin ID: " + coinId);
    }
    if (!Array.isArray(source)) {
      throw new Error("Curated annotation source is not an array: " + coinId);
    }
    result[coinId] = source.map((entry, index) =>
      resolveAnnotation(entry, coinId, index),
    );
  }
  return result;
}

export const CURATED_ANNOTATIONS: Record<string, readonly ChartAnnotation[]> =
  buildCuratedAnnotations();

const EMPTY: readonly ChartAnnotation[] = [];

export function getCuratedAnnotations(stablecoinId: string): readonly ChartAnnotation[] {
  if (!Object.prototype.hasOwnProperty.call(CURATED_ANNOTATIONS, stablecoinId)) {
    return EMPTY;
  }

  return CURATED_ANNOTATIONS[stablecoinId] ?? EMPTY;
}
