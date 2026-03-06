# Resilience Collateral Audit

Check each stablecoin's inferred/explicit `collateralQuality` against its `collateral` description.
Work 5 at a time. User confirms each batch before changes are applied and before moving on.

Status: `[ ]` pending · `[~]` in review (findings reported) · `[x]` confirmed & done

---

## USD Stablecoins (by market cap)

- [x] USDT (1)
- [x] USDC (2)
- [x] USDe (146)
- [x] USDS (209)
- [x] USD1 (262)
- [x] DAI (5) — added collateralQuality: "rwa"
- [x] PYUSD (120)
- [x] USDf (246)
- [x] USYC (237)
- [x] USDG (286)
- [x] RLUSD (250)
- [x] USDY (129)
- [x] BUIDL (173)
- [x] USDD (14)
- [x] USDTB (221)
- [x] M (213)
- [x] U (336)
- [x] USDai (309)
- [x] USD0 (195)
- [x] GHO (118)
- [x] A7A5 (258)
- [x] TUSD (7)
- [x] FDUSD (119)
- [x] CUSD (296)
- [x] EURC (50)
- [x] USR (197)
- [x] YLDS (272)
- [x] crvUSD (110)
- [x] USX (310)
- [x] USDA (220) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] FRAX (6)
- [x] DOLA (15)
- [x] AUSD (205)
- [x] IUSD (298) — added collateralQuality: "exotic"
- [x] USDF (219)
- [x] DUSD (252)
- [x] satUSD (218)
- [x] BRZ (249)
- [x] GUSD (306) — added collateralQuality: "exotic" + custodyModel: "cex"
- [x] FRXUSD (235)
- [x] rwaUSDi (340) — added collateralQuality: "rwa"
- [x] avUSD (271)
- [x] PUSD (341)
- [x] reUSD (339)
- [x] pmUSD (332)
- [x] USDz (202)
- [x] CASH (316)
- [x] MNEE (284)
- [x] TBILL (257)
- [x] FPI (66) — added collateralQuality: "rwa"
- [x] USDU (283) — added collateralQuality: "exotic", custodyModel: "institutional"
- [x] USDH (321)
- [x] LISUSD (79) — added chainRisk: "established-alt-l1", collateralQuality: "alt-lst-bridged-or-mixed"
- [x] USDO (241)
- [x] cgUSD (166)
- [x] EURCV (254)
- [x] AEUR (147)
- [x] USDQ (275)
- [x] REUSD (256) — added collateralQuality: "exotic"
- [x] EURI (325)
- [x] GUSD (19)
- [x] USDP (11)
- [x] USDX (263)
- [x] XUSD (290)
- [x] MUSD (313)
- [x] YUSD (255)
- [x] SUSD (22)
- [x] BOLD (269)
- [x] HYUSD (302)
- [x] LUSD (8)
- [x] fxUSD (168)
- [x] USDN (282)
- [x] MIM (10)
- [x] USDCV (307)
- [x] HONEY (231) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] ZCHF (226)
- [x] USDB (172) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] ZeUSD (225)
- [x] EURE (101)
- [x] USN (230) — added collateralQuality: "exotic", custodyModel: "institutional"
- [x] GYD (185) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] NECT (329) — added collateralQuality: "exotic"
- [x] EUSD (106) — added collateralQuality: "exotic"
- [x] BUCK (154) — added chainRisk: "established-alt-l1", collateralQuality: "alt-lst-bridged-or-mixed"
- [x] EURA (55) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] meUSD (303)
- [x] UTY (305)
- [x] EURS (51)
- [x] MSUSD (326) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] NUSD (346)
- [x] YZUSD (344)
- [x] JUPUSD (335)
- [x] USDM (342)
- [x] USAT (343)
- [x] cUSD (24) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] ALUSD (20)
- [x] FEUSD (251) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] FIDD (348)
- [x] USDGO (347)
- [x] MSUSD (297) — added collateralQuality: "exotic", custodyModel: "cex"
- [x] USDM (215) — added chainRisk: "established-alt-l1"
- [x] HOLLAR (312) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] USDA (245)
- [x] UUSD (75) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] AZND (327)
- [x] pUSD (266) — added custodyModel: "onchain"
- [x] WUSD (234)
- [x] SBC (324)
- [x] OUSD (23) — added collateralQuality: "exotic"
- [x] BtcUSD (183) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] USBD (253) — added collateralQuality: "alt-lst-bridged-or-mixed"
- [x] USP (331) — added collateralQuality: "exotic", custodyModel: "institutional"
- [x] USDR (240)
- [x] USDU (304) — added collateralQuality: "exotic"

## Non-USD Stablecoins

- [x] XSGD (289)
- [x] GYEN (122)
- [x] TRYB (300)
- [x] AUDD (165)
- [x] JPYC (cg-jpyc)

## Gold / Commodity

- [x] XAUT (gold-xaut)
- [x] PAXG (gold-paxg)
- [x] KAU (gold-kau)
- [x] XAUm (gold-xaum)
- [x] VRO (gold-vro)
- [x] CGO (gold-cgo)
- [x] DGLD (gold-dgld)
- [x] KAG (silver-kag)

## EUR / Other Fiat

- [x] CEUR (52) — added chainRisk: "established-alt-l1", collateralQuality: "alt-lst-bridged-or-mixed"
- [x] VEUR (158)
- [x] EURR (239)
- [x] EUROP (247)
- [x] EURQ (cg-eurq)
- [x] EURAU (319)
- [x] DEURO (cg-deuro)
- [x] VCHF (157)
- [x] VGBP (292)
- [x] tGBP (317)
- [x] ZARP (cg-zarp)
- [x] ISC (186) — added chainRisk: "established-alt-l1"
- [x] CADC (145)
- [x] PHT (299) — added collateralQuality: "exotic", custodyModel: "institutional"
