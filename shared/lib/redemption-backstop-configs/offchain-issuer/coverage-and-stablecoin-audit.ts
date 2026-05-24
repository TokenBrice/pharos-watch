import type { RedemptionBackstopConfig } from "../shared";
import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  undisclosedReviewedFee,
  issuerBase,
  sourceRef,
} from "../shared";
import {
  reviewedDirectRedemptionSupplyFull,
  REVIEWED_COVERAGE_EXPANSION_AT,
  REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
  REVIEWED_STABLECOIN_AUDIT_AT,
} from "./shared";

export const COVERAGE_AND_STABLECOIN_AUDIT_OFFCHAIN_CONFIGS: Record<string, RedemptionBackstopConfig> = {
  "usdt-tether": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
    costModel: documentedVariableFee("0.10% with a $1,000 minimum"),
    docs: [
      sourceRef("Tether Transparency", "https://tether.to/en/transparency", ["capacity"]),
      sourceRef("Tether legal terms", "https://tether.to/en/legal/", ["route", "capacity", "access"]),
      sourceRef("Tether fees", "https://tether.to/en/fees/", ["fees", "access"]),
    ],
  },
  "usdc-circle": {
    ...issuerBase,
    ...reviewedDirectRedemptionSupplyFull,
    reviewedAt: REVIEWED_MAJOR_ISSUER_REDEMPTION_AT,
    costModel: documentedVariableFee("1:1 via Circle Mint; EEA burn fee is 0 bps, other Circle fees may vary"),
    docs: [
      sourceRef("Circle Transparency", "https://www.circle.com/transparency", ["capacity"]),
      sourceRef("Circle USDC terms", "https://www.circle.com/legal/usdc-terms", [
        "route",
        "capacity",
        "access",
        "fees",
      ]),
    ],
  },
  "bfusd-binance": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    settlementModel: "days",
    executionModel: "opaque",
    routeStatus: "open",
    costModel: documentedVariableFee(
      "Binance terms allow variable fees, delays, limits, and suspension rights for BFUSD purchase and redemption",
    ),
    docs: [
      sourceRef(
        "Binance BFUSD FAQ",
        "https://www.binance.com/en/support/faq/what-is-bfusd-and-how-to-get-started-with-bfusd-2bb2db6e81bd4958996307bb4b206d97",
        ["route", "access"],
      ),
      sourceRef(
        "Binance BFUSD product terms",
        "https://bin.bnbstatic.com/static/cms/cg08ou2ak0tn7mcplvfg/file/c1dd5e9f6a6191ca85b3cd256bd831884372530e3b4204b9006bf273650c6f5b.pdf",
        ["route", "capacity", "fees", "settlement"],
      ),
    ],
    notes: [
      "BFUSD is modeled as a Binance-account issuer route, not an on-chain token redemption path; Binance may delay or suspend redemption under its terms",
    ],
  },
  "pathusd-bridge": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    settlementModel: "same-day",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Bridge-supported pathUSD exchange/redemption uses Bridge rails; public materials reviewed do not publish one fixed pathUSD redemption fee",
    ),
    docs: [
      sourceRef("Tempo pathUSD docs", "https://docs.tempo.xyz/protocol/exchange/pathUSD", ["route", "access", "fees"]),
      sourceRef("Bridge issuance FAQ", "https://apidocs.bridge.xyz/platform/issuance/faq", [
        "capacity",
        "settlement",
        "fees",
      ]),
    ],
    notes: [
      "Modeled as verified Bridge/Tempo primary-market redeemability into USDC rather than independently measured instant on-chain liquidity",
    ],
  },
  "usp-pareto-credit": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Pareto docs describe verified-user USP mint/redeem flow; public materials reviewed do not publish a single fixed redemption fee",
    ),
    docs: [
      sourceRef("Pareto USP docs", "https://docs.pareto.credit/product/usp", [
        "route",
        "access",
        "capacity",
        "fees",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled for verified primary-market users; unverified secondary-market holders still depend on market liquidity or onboarding before direct redemption",
    ],
  },
  "gbpe-monerium": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    costModel: undisclosedReviewedFee(
      "Monerium fee schedule and terms govern bank-transfer redemption; public materials reviewed do not publish a single fixed GBPe redemption fee",
    ),
    docs: [
      sourceRef("Monerium financial information", "https://monerium.com/financial-information/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Monerium fee schedule", "https://monerium.com/fee-schedule/", ["fees"]),
    ],
    notes: ["Modeled as regulated e-money redemption for onboarded Monerium customers through bank-transfer rails"],
  },
  "qcad-stablecorp": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_COVERAGE_EXPANSION_AT),
    costModel: undisclosedReviewedFee(
      "Stablecorp/authorized-partner redemption terms govern QCAD redemption; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Stablecorp transparency", "https://stablecorp.ca/transparency", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Stablecorp balances API", "https://api.sdc.stablecorp.ca/reports/balances?type=unformatted_json", [
        "capacity",
      ]),
    ],
    notes: ["Modeled as issuer redemption for qualified holders under QCAD Digital Trust and authorized partner rails"],
  },
  "dusd-fluid": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Fluid materials describe bank-account mint/redeem flows for DUSD; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Fluid DUSD", "https://fluid.ch/dusd/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef(
        "Fluid app mint/redeem guide",
        "https://medium.com/fluidfi/how-to-use-the-web-app-and-mint-redeem-digitaldollar-dusd-5183c8dcfb6",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as verified-user bank-rail redemption, not as an on-chain permissionless stablecoin swap; reserve visibility still depends on Fluid's self-reported on-chain treasury balance.",
    ],
  },
  "mre7yield-midas": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed mRe7YIELD redemption fee",
    ),
    docs: [
      sourceRef("Midas mRe7YIELD", "https://docs.midas.app/tokens/mre7yield", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Midas smart contracts", "https://docs.midas.app/protocol-mechanics/smart-contracts", [
        "route",
        "access",
      ]),
    ],
    notes: [
      "mRe7YIELD is a NAV-accreting strategy token, so the route is modeled as issuer/platform NAV redemption rather than same-day stablecoin par liquidity.",
    ],
  },
  "mf-one-midas": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-14"),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed mF-ONE redemption fee",
    ),
    docs: [
      sourceRef("Midas mF-ONE", "https://midas.app/mfone", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Midas token docs", "https://docs.midas.app/liquid-yield-token", ["route", "access", "settlement"]),
    ],
    notes: [
      "mF-ONE is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.",
    ],
  },
  "mglobal-midas-fasanara": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-14"),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed mGLOBAL redemption fee",
    ),
    docs: [
      sourceRef("Midas mGLOBAL", "https://midas.app/mglobal", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Midas token docs", "https://docs.midas.app/liquid-yield-token", ["route", "access", "settlement"]),
    ],
    notes: [
      "mGLOBAL is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.",
    ],
  },
  "mhyper-midas": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-14"),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed mHYPER redemption fee",
    ),
    docs: [
      sourceRef("Midas mHYPER", "https://midas.app/mhyper", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Midas token docs", "https://docs.midas.app/liquid-yield-token", ["route", "access", "settlement"]),
    ],
    notes: [
      "mHYPER is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.",
    ],
  },
  "mmev-midas": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-14"),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed mMEV redemption fee",
    ),
    docs: [
      sourceRef("Midas mMEV", "https://docs.midas.app/tokens/mmev", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Midas token docs", "https://docs.midas.app/liquid-yield-token", ["route", "access", "settlement"]),
    ],
    notes: [
      "mMEV is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.",
    ],
  },
  "mapollo-midas": {
    ...issuerBase,
    ...documentedBoundSupplyFull("2026-05-14"),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Midas token docs describe primary-market redemption through Midas rails; public materials reviewed do not publish one fixed mAPOLLO redemption fee",
    ),
    docs: [
      sourceRef("Midas mAPOLLO", "https://midas.app/mapollo", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Midas token docs", "https://docs.midas.app/liquid-yield-token", ["route", "access", "settlement"]),
    ],
    notes: [
      "mAPOLLO is a NAV-accreting Midas strategy token, so the route is modeled as issuer/platform NAV redemption rather than stablecoin par liquidity.",
    ],
  },
  "benji-franklin-templeton": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    costModel: undisclosedReviewedFee(
      "Franklin Templeton materials describe BENJI redemptions through the Benji app/platform; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef(
        "Franklin FOBXX prospectus",
        "https://www.franklintempleton.com/forms-literature/download-preview/9001-P",
        ["route", "capacity", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Franklin FOBXX fund page",
        "https://www.franklintempleton.com/investments/options/money-market-funds/products/29380/SINGLCLASS/franklin-on-chain-u-s-government-money-fund/FOBXX",
        ["capacity", "access"],
      ),
      sourceRef("Benji app", "https://benji.franklintempleton.com/", ["route", "access"]),
    ],
    notes: [
      "Modeled as KYC-gated Benji platform redemption of fund shares, not as permissionless secondary-market liquidity.",
    ],
  },
  "wtgxx-wisdomtree": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "WisdomTree Connect supports subscriptions and redemptions through USD wires or stablecoin conversion; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("WisdomTree Connect", "https://www.wisdomtreeconnect.com/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("WTGXX fund page", "https://www.wisdomtree.com/investments/digital-funds/money-market/wtgxx", [
        "capacity",
        "fees",
      ]),
    ],
    notes: [
      "Same-day settlement depends on U.S. trading-day cutoffs; 24/7 dealer settlement is modeled as platform primary-market access, not independent on-chain liquidity.",
    ],
  },
  "vbill-vaneck": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Securitize materials describe VBILL subscription and redemption at fund NAV; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Securitize VBILL", "https://securitize.io/primary-market/vaneck-vbill", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "VanEck VBILL launch",
        "https://www.prnewswire.com/news-releases/vaneck-launches-first-tokenized-fund-vbill-on-securitize-302453863.html",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as qualified-investor Securitize primary-market redemption at NAV, not as secondary exchange liquidity.",
    ],
  },
  "jtrsy-anemoy": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Centrifuge materials describe whitelisted pool investment and redemption flows; public materials reviewed do not publish one fixed JTRSY redemption fee",
    ),
    docs: [
      sourceRef("Centrifuge JTRSY pool", "https://centrifuge.io/pools/jtrsy", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Centrifuge investor docs", "https://docs.centrifuge.io/user/investor/", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as whitelisted Professional Investor redemption through the Centrifuge issuer rail; async vault processing can delay settlement.",
    ],
  },
  "jaaa-janus-henderson-anemoy": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Anemoy materials describe subscriptions and redemptions in stablecoins; public materials reviewed do not publish one fixed JAAA redemption fee",
    ),
    docs: [
      sourceRef("Anemoy JAAA fund", "https://www.anemoy.io/funds/jaaa", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Centrifuge investor docs", "https://docs.centrifuge.io/user/investor/", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as whitelisted professional-investor redemption through the Anemoy / Centrifuge fund rail; tokenized CLO-fund NAV processing is slower and more access-limited than on-chain stablecoin liquidity.",
    ],
  },
  "acrdx-anemoy-apollo": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Anemoy / Centrifuge materials describe qualified-investor ACRDX subscriptions and redemptions; public materials reviewed do not publish one fixed ACRDX redemption fee",
    ),
    docs: [
      sourceRef("Anemoy ACRDX launch", "https://www.anemoy.io/news/acrdx-launched", [
        "route",
        "capacity",
        "access",
        "settlement",
      ]),
      sourceRef("RWA.xyz ACRDX profile", "https://app.rwa.xyz/assets/ACRDX", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Centrifuge investor docs", "https://docs.centrifuge.io/user/investor/", [
        "route",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as qualified-investor NAV redemption through the Anemoy / Centrifuge issuer rail, mirroring the Apollo credit fund template while preserving queued private-credit settlement risk.",
    ],
  },
  "ustbl-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed USTBL redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko investor redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    ],
  },
  "safo-spiko-usd": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed SAFO redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko investor redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko dollar fund", "https://www.spiko.io/spiko-dollar", ["capacity", "fees", "access"]),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated Spiko / Amundi fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    ],
  },
  "spkcc-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed SPKCC redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko investor redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko cash and carry fund", "https://www.spiko.io/spiko-cash-and-carry", [
        "capacity",
        "fees",
        "access",
      ]),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated Spiko cash-and-carry fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    ],
  },
  "uktbl-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed UKTBL redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko investor redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko UK Treasury bills fund", "https://www.spiko.io/spiko-treasury-bills-pound", [
        "capacity",
        "fees",
        "access",
      ]),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated GBP money-market fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    ],
  },
  "gbpsafo-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed GBPSAFO redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko investor redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko pound fund", "https://www.spiko.io/spiko-pound", ["capacity", "fees", "access"]),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated Spiko / Amundi GBP fund-share redemption at NAV; cutoff times and bank rails make the backstop slower than on-chain stablecoin liquidity.",
    ],
  },
  "eutbl-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed EUTBL redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko instant redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-instant-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    ],
  },
  "eursafo-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed EURSAFO redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko instant redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-instant-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko euro fund", "https://www.spiko.io/spiko-euro", ["capacity", "fees", "access"]),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated Spiko / Amundi EUR fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    ],
  },
  "eurspkcc-spiko": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Spiko docs describe withdrawal/redemption orders and fund-product terms; public materials reviewed do not publish one fixed EURSPKCC redemption fee",
    ),
    docs: [
      sourceRef(
        "Spiko deposits and withdrawals",
        "https://docs.spiko.io/documentation/account_management/deposits_withdrawals",
        ["route", "fees", "access", "settlement"],
      ),
      sourceRef(
        "Spiko instant redemption API",
        "https://docs.spiko.io/developers/investor_api/reference/redemption-orders-create-instant-redemption-order",
        ["route", "access", "settlement"],
      ),
      sourceRef("Spiko cash and carry fund", "https://www.spiko.io/spiko-cash-and-carry", [
        "capacity",
        "fees",
        "access",
      ]),
      sourceRef("Spiko SICAV prospectus", "https://cdn.spiko.finance/legal_docs/EN/Prospectus_Spiko_SICAV_EN.pdf", [
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
    ],
    notes: [
      "Modeled as account-gated Spiko EUR cash-and-carry fund-share redemption at NAV; instant withdrawals are eligibility-limited and standard withdrawals remain bank-rail dependent.",
    ],
  },
  "stac-securitize": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Securitize materials describe STAC subscriptions and redemptions at fund NAV; public materials reviewed do not publish one fixed STAC redemption fee",
    ),
    docs: [
      sourceRef("Securitize STAC", "https://securitize.io/primary-market/Securitize-BNY-CLO-Fund", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Securitize STAC launch",
        "https://securitize.io/learn/press/Securitize-Launches-Tokenized-AAA-CLO-Fund-with-BNY",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as qualified-investor Securitize primary-market redemption at NAV, not as secondary exchange liquidity.",
    ],
  },
  "hlscope-hamilton-lane": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "queued",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Securitize / Hamilton Lane materials describe SCOPE feeder-fund redemption features; public materials reviewed do not publish one fixed HLSCOPE redemption fee",
    ),
    docs: [
      sourceRef("Securitize HLSCOPE", "https://securitize.io/primary-market/hl-scope", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "Hamilton Lane SCOPE via Securitize",
        "https://www.hamiltonlane.com/en-us/news/scope-available-via-securitize",
        ["route", "capacity", "access", "settlement"],
      ),
    ],
    notes: [
      "Modeled as a Securitize client redemption route for qualified Hamilton Lane SCOPE feeder-fund investors, preserving private-credit feeder settlement and access limits.",
    ],
  },
  "bib01-backed": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Backed documents bToken redemption into stablecoins or cash within T+3; public materials reviewed do not publish one fixed bIB01 redemption fee",
    ),
    docs: [
      sourceRef("Backed redemption docs", "https://docs.backed.fi/backed-platform/issuance-and-redemption/redemption", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Backed bIB01 product", "https://assets.backed.fi/products/bib01", ["capacity", "fees", "access"]),
      sourceRef("Backed product structure", "https://assets.backed.fi/structure", ["capacity", "access"]),
    ],
    notes: [
      "Modeled as Backed primary-market redemption for approved customers; T+3 processing and market-hours execution make it slower than secondary DEX exits.",
    ],
  },
  "bc3m-backed": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    outputAssetType: "nav",
    costModel: undisclosedReviewedFee(
      "Backed documents bToken redemption into stablecoins or cash within T+3; public materials reviewed do not publish one fixed bC3M redemption fee",
    ),
    docs: [
      sourceRef("Backed redemption docs", "https://docs.backed.fi/backed-platform/issuance-and-redemption/redemption", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("Backed bC3M product", "https://assets.backed.fi/products/bc3m", ["capacity", "fees", "access"]),
      sourceRef("Backed product structure", "https://assets.backed.fi/structure", ["capacity", "access"]),
    ],
    notes: [
      "Modeled as Backed primary-market redemption for approved customers; bC3M remains a EUR-denominated NAV tracker rather than a euro stablecoin cash claim.",
    ],
  },
  "cadd-cad-digital": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "CADD trust terms define 1:1 CAD redemption less any administrative fee; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("CADD trust indenture", "https://tetradg.com/tetra-trust-indenture/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef("CADD reserve attestations", "https://tetradg.com/cadd-reserve-attestations/", ["capacity", "fees"]),
      sourceRef("CADD stablecoin page", "https://tetradg.com/cadd-stablecoin/", ["route", "access"]),
    ],
    notes: [
      "Modeled as CAD Digital issuer redemption to approved participant or registered end-user bank accounts, not as permissionless on-chain CAD liquidity.",
    ],
  },
  "myrc-blox": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    settlementModel: "days",
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "Blox materials describe 1:1 MYRC redemption for Malaysian Ringgit; product terms leave issuance and redemption subject to Blox terms and do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("Blox MYRC", "https://www.blox.my/myrc", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("Blox MYRC transparency", "https://www.blox.my/myrc/transparency", ["route", "capacity"]),
      sourceRef("Blox product term sheet", "https://www.blox.my/policies/product-term-sheet", [
        "route",
        "fees",
        "access",
      ]),
    ],
    notes: [
      "Modeled as Malaysian eKYC and bank-account redemption through Blox/FPX rails; the route is jurisdiction- and account-limited.",
    ],
  },
  "krwq-iq": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    executionModel: "opaque",
    costModel: undisclosedReviewedFee(
      "KRWQ materials expose a Mint/Redeem flow and KYC-gated institutional controls; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("KRWQ homepage", "https://www.krwq.cash/", ["route", "capacity", "fees", "access", "settlement"]),
      sourceRef("KRWQ mint/redeem", "https://www.krwq.cash/mint", ["route", "access"]),
      sourceRef("KRWQ whitepaper", "https://www.krwq.cash/whitepaper.pdf", ["capacity", "fees", "access"]),
    ],
    notes: [
      "Modeled as KYC-gated KRWQ platform redemption; public materials still point to future formal attestations, so reserve transparency remains separate from route existence.",
    ],
  },
  "sofid-sofi": {
    ...issuerBase,
    ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
    routeStatus: "open",
    costModel: undisclosedReviewedFee(
      "BitGo Mint supports native SoFiUSD minting and redemption for institutions; public materials reviewed do not publish one fixed redemption fee",
    ),
    docs: [
      sourceRef("SoFiUSD", "https://www.sofi.com/crypto/sofiusd/", [
        "route",
        "capacity",
        "fees",
        "access",
        "settlement",
      ]),
      sourceRef(
        "BitGo Mint launch",
        "https://investors.bitgo.com/news/news-details/2026/BitGo-Launches-BitGo-Mint-Native-Stablecoin-Minting-and-Redemption-for-Institutions/default.aspx",
        ["route", "access", "settlement"],
      ),
      sourceRef(
        "BitGo SoFiUSD infrastructure",
        "https://www.bitgo.com/resources/blog/bitgo-selected-by-sofi-to-provide-stablecoin-infrastructure/",
        ["route", "capacity", "access"],
      ),
    ],
    notes: ["Modeled as institutional BitGo/SoFi issuer redemption, not a retail self-service on-chain burn path."],
  },
};
