---
title: "Update mint-burn-flows.md config table + runbook IDs"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Replace all old stablecoin IDs in the contract config table in `docs/mint-burn-flows.md` and the CCIP config list in `docs/runbooks/mint-burn-ingestion.md` with canonical `ticker-issuer` IDs.

## Task

### Part A: `docs/mint-burn-flows.md` (lines 63-139)

The "Tracked Stablecoins" table has an `ID` column with old IDs. Replace every ID with the canonical ticker-issuer ID from `worker/src/lib/mint-burn-contracts.ts` (the `stablecoinId` field).

Use the following mapping for the table. Each row shows `Symbol | old ID → new ID`:

**Safe haven:**
- USDT | `1` → `usdt-tether`
- USDC | `2` → `usdc-circle`
- FDUSD | `119` → `fdusd-first-digital`
- PYUSD | `120` → `pyusd-paypal`

**Risky:**
- DAI | `5` → `dai-makerdao`
- GHO | `118` → `gho-aave`
- USDe | `146` → `usde-ethena`
- USDS | `209` → `usds-sky`
- FRXUSD | `235` → `frxusd-frax`
- BOLD | `269` → `bold-liquity`

**Extended (update ALL entries):**
- fxUSD | `168` → `fxusd-f-x-protocol`
- crvUSD | `110` → `crvusd-curve`
- AUSD | `205` → `ausd-agora`
- ZCHF | `226` → `zchf-frankencoin`
- EURC | `50` → `eurc-circle`
- PAXG | `gold-paxg` → `paxg-paxos`
- XAUT | `gold-xaut` → `xaut-tether`
- USDG | `286` → `usdg-paxos`
- USD1 | `262` → `usd1-world-liberty-financial`
- USDf | `246` → `usdf-falcon`
- USYC | `237` → `usyc-hashnote`
- RLUSD | `250` → `rlusd-ripple`
- USDY | `129` → `usdy-ondo-finance`
- BUIDL | `173` → `buidl-blackrock`
- USDD | `14` → `usdd-tron-dao-reserve`
- USDTB | `221` → `usdtb-ethena`
- M | `213` → `m-m0`
- USD0 | `195` → `usd0-usual`
- TUSD | `7` → `tusd-trueusd`
- CUSD | `296` → `cusd-cap`
- USR | `197` → `usr-resolv`
- FRAX | `6` → `frax-frax`
- DOLA | `15` → `dola-inverse-finance`
- IUSD | `298` → `iusd-infinifi`
- GUSD | `306` → `gusd-gate`
- avUSD | `271` → `avusd-avant`
- pmUSD | `332` → `pmusd-precious-metals`
- USDz | `202` → `usdz-anzen`
- MNEE | `284` → `mnee-mnee`
- TBILL | `257` → `tbill-openeden`
- USDO | `241` → `usdo-openeden`
- EURCV | `254` → `eurcv-societe-generale-forge`
- REUSD | `256` → `reusd-resupply`
- EURI | `325` → `euri-banking-circle`
- GUSD | `19` → `gusd-gemini`
- USDP | `11` → `usdp-paxos`
- XUSD | `290` → `xusd-straitsx`
- MUSD | `313` → `musd-metamask`
- YUSD | `255` → `yusd-aegis`
- SUSD | `22` → `susd-synthetix`
- LUSD | `8` → `lusd-liquity`
- USDCV | `307` → `usdcv-societe-generale-forge`
- EURE | `101` → `eure-monerium`
- USN | `230` → `usn-noon`
- EUSD | `106` → `eusd-electronic-usd`
- EURA | `55` → `eura-angle`
- meUSD | `303` → `meusd-mezo`
- MSUSD | `326` → `msusd-metronome`
- NUSD | `346` → `nusd-neutrl`
- ALUSD | `20` → `alusd-alchemix`
- FIDD | `348` → `fidd-fidelity`
- MSUSD | `297` → `msusd-main-street`
- WUSD | `234` → `wusd-worldwide`
- SBC | `324` → `sbc-brale`
- OUSD | `23` → `ousd-origin-protocol`
- USP | `331` → `usp-pikudao`
- USDR | `240` → `usdr-stablr`
- USTB | `cg-ustb` → `ustb-superstate`
- OUSG | `cg-ousg` → `ousg-ondo-finance`
- mTBILL | `cg-mtbill` → `mtbill-midas`
- wsrUSD | `cg-wrapped-savings-rusd` → `wsrusd-reservoir`
- AUDD | `165` → `audd-novatti`
- JPYC | `cg-jpyc` → `jpyc-jpyc`
- XAUm | `gold-xaum` → `xaum-matrixdock`
- EURR | `239` → `eurr-stablr`
- EUROP | `247` → `europ-schuman`
- DEURO | `cg-deuro` → `deuro-deuro`
- tGBP | `317` → `tgbp-tokenised`
- syrupUSDC | `cg-syrupusdc` → `syrupusdc-maple`
- syrupUSDT | `cg-syrupusdt` → `syrupusdt-maple`
- AID | `353` → `aid-gaib`
- apxUSD | `354` → `apxusd-apyx`
- reUSD | `339` → `reusd-re-protocol`

This is the complete list. If any rows exist in the docs table that are not in this mapping, look up the canonical ID from `worker/src/lib/mint-burn-contracts.ts` by matching on symbol.

### Part B: `docs/runbooks/mint-burn-ingestion.md` (lines 15-19)

Replace the CCIP config list IDs:

**Before:**
```markdown
- `2` (`USDC`) — pool `0x03d19033ada17750d5bc2d8e325337d0748f9fef`
- `241` (`USDO`) — pool `0x500d4882938020e939a5666c1b4200873da7efd3`
- `262` (`USD1`) — pool `0x36a72ed0096b414521c45e3ddc9ed657d1d9c141`
- `271` (`avUSD`) — pool `0x81b72171642fab457aa815c0b8412a22b63a6af8`
- Baseline pre-existing config: `226` (`ZCHF`)
```

**After:**
```markdown
- `usdc-circle` (`USDC`) — pool `0x03d19033ada17750d5bc2d8e325337d0748f9fef`
- `usdo-openeden` (`USDO`) — pool `0x500d4882938020e939a5666c1b4200873da7efd3`
- `usd1-world-liberty-financial` (`USD1`) — pool `0x36a72ed0096b414521c45e3ddc9ed657d1d9c141`
- `avusd-avant` (`avUSD`) — pool `0x81b72171642fab457aa815c0b8412a22b63a6af8`
- Baseline pre-existing config: `zchf-frankencoin` (`ZCHF`)
```

## Acceptance Criteria

- `npm run build` exits 0
- `grep -cE '^\| .+ \| [0-9]+ \|' docs/mint-burn-flows.md` returns 0 (no remaining purely numeric IDs in the table — IDs should contain hyphens)
- `grep -c 'gold-paxg\|gold-xaut\|gold-xaum\|cg-ustb\|cg-ousg\|cg-mtbill\|cg-jpyc\|cg-wrapped' docs/mint-burn-flows.md` returns 0
- `grep -c 'usdt-tether' docs/mint-burn-flows.md` returns >= 1
- `grep -c 'paxg-paxos' docs/mint-burn-flows.md` returns >= 1
- `grep -cE '^\- `[0-9]+` \(' docs/runbooks/mint-burn-ingestion.md` returns 0 (no remaining numeric IDs in CCIP list)
- `grep -c 'usdc-circle' docs/runbooks/mint-burn-ingestion.md` returns >= 1
