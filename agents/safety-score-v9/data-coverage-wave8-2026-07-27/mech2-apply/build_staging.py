#!/usr/bin/env python3
"""KIMI-MECH-2 wave-8 staging builder.

Constructs the 42 final overlay entries (group A drafts + group B packet
conversions) with the verdict-mandated amendments, plus all measurement
journals, into mech2-apply/staging/. Does NOT touch shared/.
"""
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(ROOT)  # data-coverage-wave8-2026-07-27
REPO = os.path.abspath(os.path.join(BASE, "..", "..", ".."))
DRAFTS = os.path.join(BASE, "mech2-drafts")
PACKETS = os.path.join(BASE, "mech-packets")
VERDICTS = os.path.join(DRAFTS, "verdicts")
OVERLAY_FILE = os.path.join(REPO, "shared/data/safety-score-v9/mechanism-review-overlays-v1.json")
STAGING = os.path.join(ROOT, "staging")

REVIEWED_AT = "2026-07-27"

report = []


def load(path):
    with open(path) as f:
        return json.load(f)


def draft(aid):
    return load(os.path.join(DRAFTS, aid + ".json"))


def packet(aid):
    p = load(os.path.join(PACKETS, aid + ".json"))
    if isinstance(p.get("notes"), str):
        p["notes"] = clean_packet_notes(p["notes"])
    return p


_PENDING_RE = re.compile(r"\s*verification(?:\.verdict)?(?:\s+left)?\s+PENDING[^.]*\.\s*", re.IGNORECASE)
_UNTOUCHED_RE = re.compile(r"\s*Overlay(?:\s+file)?\s+untouched[;.]\s*", re.IGNORECASE)


def clean_packet_notes(notes):
    """Drop pre-verification process chatter (no landed overlay entry carries it)."""
    n = _PENDING_RE.sub(" ", notes)
    n = _UNTOUCHED_RE.sub(" ", n)
    return re.sub(r" {2,}", " ", n).strip()


def verdict(aid):
    return load(os.path.join(VERDICTS, aid + ".json"))


def condense(basis, limit=420):
    if len(basis) <= limit:
        return basis
    cut = basis.rfind(". ", 0, limit)
    if cut < 120:
        cut = limit
    return basis[: cut + 1]


def fold_bases(notes, components, fixes=None):
    """Append concise component basis summaries to thin packet notes."""
    if not components:
        return notes
    parts = []
    for key, comp in components.items():
        basis = comp.get("basis", "")
        if fixes and key in fixes:
            basis = fixes[key]
        parts.append(f"{key} ({comp['quality']}) — {condense(basis)}")
    return notes.rstrip() + " Component evidence: " + "; ".join(parts) + "."


def packet_sources(p):
    return [{"label": s["label"], "url": s["url"]} for s in p["sources"]]


def packet_components(p, fixes=None):
    comps = {}
    for key, comp in (p.get("components") or {}).items():
        comps[key] = {"quality": comp["quality"]}
    return comps


def packet_metric_applicability(p, only_non_measured=True):
    appl = {}
    for key, st in (p.get("metricStates") or {}).items():
        if only_non_measured and st["state"] == "measured":
            continue
        if st["state"] == "measured":
            appl[key] = {"state": "measured"}
        else:
            appl[key] = {"state": st["state"], "rationale": st["rationale"], "sourceUrl": st["sourceUrl"]}
    return appl


def sanitize_analogous(am, aid=None):
    """Overlay schema requires finite numbers; coerce numeric-string raw values.

    Values beyond Number.MAX_SAFE_INTEGER are rejected by the stable-json
    serializer, so those raw keys are dropped from the entry (they remain in
    the measurement journal as exact strings).
    """
    out = {}
    for k, v in (am or {}).items():
        if isinstance(v, str) and v.isdigit():
            v = int(v)
        if isinstance(v, (int, float)):
            if isinstance(v, int) and abs(v) > 2**53 - 1:
                report.append(f"{aid}: analogousMetrics.{k} dropped (exceeds MAX_SAFE_INTEGER; preserved in journal)")
                continue
            out[k] = v
        else:
            raise ValueError(f"analogousMetrics.{k} not numeric: {v!r}")
    return out


def packet_entry(aid, notes, sources=None, components=None, metrics=None,
                 metric_applicability=None, venue_shares=None, analogous=None):
    p = packet(aid)
    entry = {
        "assetId": aid,
        "archetype": p["archetype"],
        "reviewedAt": REVIEWED_AT,
        "sources": sources if sources is not None else packet_sources(p),
        "notes": notes,
        "metrics": metrics if metrics is not None else dict(p["metrics"]),
    }
    if metric_applicability:
        entry["metricApplicability"] = metric_applicability
    if analogous is None and "analogousMetrics" in p:
        analogous = p["analogousMetrics"]
    analogous = sanitize_analogous(analogous, aid)
    if analogous:
        entry["analogousMetrics"] = analogous
    vs = venue_shares if venue_shares is not None else p.get("venueShares")
    if vs:
        entry["venueShares"] = vs
    entry["components"] = components if components is not None else packet_components(p)
    return entry


def simple_packet_entry(aid, fold=True, basis_fixes=None, extra_notes=""):
    p = packet(aid)
    notes = p["notes"].rstrip()
    if extra_notes:
        notes += " " + extra_notes
    if fold:
        notes = fold_bases(notes, p.get("components") or {}, basis_fixes)
    appl = packet_metric_applicability(p)
    return packet_entry(aid, notes, metric_applicability=appl if appl else None)


# ---------------------------------------------------------------- group A ---

def group_a(aid, amend=None):
    d = draft(aid)
    entry = json.loads(json.dumps(d["overlayEntry"]))  # deep copy
    if amend:
        amend(entry)
    return d, entry


def amend_asusdf(entry):
    notes = entry["notes"]
    assert "4-of-8 Safe" in notes
    entry["notes"] = notes.replace("4-of-8 Safe", "4-of-7 Safe")
    src0 = entry["sources"][0]
    assert "T+1 hour withdrawal" in src0["label"]
    src0["label"] = src0["label"].replace("; T+1 hour withdrawal", "")
    entry["sources"].insert(1, {
        "label": "Aster USDF FAQs (withdrawals subject to a T+1 hour waiting period)",
        "url": "https://docs.asterdex.com/usdf-stablecoin/overview/faqs.md",
    })
    report.append("asusdf: notes 4-of-8->4-of-7; T+1 claim re-attributed to USDF FAQs source")


def amend_reusd_re(entry):
    notes = entry["notes"]
    old = "the token issuer is an unregulated Cayman foundation"
    assert old in notes
    entry["notes"] = notes.replace(old, "the token issuer is Resilience (BVI) Ltd., an unregulated BVI company")
    entry["sources"].append({
        "label": "Re Protocol legal structure index (PPM and platform agreement PDFs)",
        "url": "https://docs.re.xyz/glossary-and-reference/legal-structure.md",
    })
    entry["sources"].append({
        "label": "Resilience / Re Protocol Private Placement Memorandum ppm_v2.pdf (Daily Accrual Price 00:00 UTC; reUSD senior vs reUSDe contractual subordination; limited recourse)",
        "url": "https://storage.googleapis.com/re-files-production/docs/ppm_v2.pdf",
    })
    report.append("reusd-re-protocol: issuer corrected to Resilience (BVI) Ltd.; PPM + legal-structure sources appended")


def amend_stcusd(entry):
    assert entry["metrics"]["weightedAverageMaturityDays"] == 3.000821
    entry["metrics"]["weightedAverageMaturityDays"] = 2.999366
    old = ("weightedAverageMaturityDays 3.000821 refreshes the prior 3.023155 with the same methodology: "
           "the WTGXX basket share (5.10/73.08 = 6.9787%, corroborated by the dashboard's 6.99% deployment slice) "
           "multiplied by the fund's SEC-filed 43-day average portfolio maturity")
    new = ("weightedAverageMaturityDays 2.999366 refreshes the prior 3.023155 with the same methodology: "
           "the WTGXX basket share derived from same-block on-chain totalSupplies reads at Ethereum block 25627164 "
           "(6.9753%, the packet's on-chain-derived sleeve weight; the dashboard-rounded figures 5.10/73.08 would give "
           "3.000821 and the dashboard's 6.99% deployment slice corroborates) "
           "multiplied by the fund's SEC-filed 43-day average portfolio maturity")
    assert old in entry["notes"]
    entry["notes"] = entry["notes"].replace(old, new)
    report.append("stcusd-cap: WAM 3.000821 -> 2.999366 (packet on-chain pin block 25627164); notes WAM sentence adjusted")


def amend_usn(entry):
    entry["components"]["legalEnforceability"] = {"quality": "limited"}
    old = "legalEnforceability is left bounded: no prospectus, regulatory filing, or enforceable public holder terms were located."
    new = ("legalEnforceability is limited (verifier-confirmed basis): mint and redeem are permissioned for "
           "institutional KYC/KYB wallets with 1:1 settlement (minting/product docs plus the custody page naming "
           "Alpaca/Dinari, Ceffu, ForDefi, and Fasanara fund custody), but the token is a protocol liability backed "
           "by mixed CeFi/TradFi/DeFi deployments rather than a registered public fund share, so contractual "
           "enforceability for retail secondary holders is limited; no prospectus or regulatory filing was located.")
    assert old in entry["notes"]
    entry["notes"] = entry["notes"].replace(old, new)
    report.append("usn-noon: legalEnforceability limited component added from packet; notes basis sentence updated")


RUSD_WAM_OLD = ("weightedAverageMaturityDays 7.9647 treats the on-demand-redeemable lending/vault/stablecoin sleeves "
                "(74.31%) as 0-day and the 25.69% Pendle PT sleeve at its documented fixed maturity 2026-08-27 "
                "(31 days from the 2026-07-27 read), matching the wsrusd-reservoir precedent methodology; "
                "the 45.16% Sentora PRIME sleeve's underlying HELOC maturities are issuer-undisclosed and "
                "conservatively treated as 0-day.")
RUSD_WAM_NEW = ("weightedAverageMaturityDays is unavailable: the 25.69% Pendle PT sleeve has a documented fixed "
                "maturity of 2026-08-27 (31 days from the 2026-07-27 read), but the 45.16% Sentora PRIME and "
                "3.65% Agua Global Carry sleeves publish no maturity profile, so no portfolio WAM is derivable "
                "under D3; an earlier 0-day-assumption derivation was rejected as a prohibited score-flattering "
                "derivation.")
RUSD_WAM_RATIONALE = ("Balance sheet mixes money-market aTokens, Morpho/prime vaults, and a dated PT (27AUG2026) "
                      "without issuer-published portfolio WAM. Searched Reservoir PoR docs, risk overview, "
                      "credit enforcer, reserves API (no maturity field).")


def amend_reservoir(aid):
    def _amend(entry):
        assert entry["metrics"]["weightedAverageMaturityDays"] == 7.9647
        entry["metrics"]["weightedAverageMaturityDays"] = None
        assert RUSD_WAM_OLD in entry["notes"]
        entry["notes"] = entry["notes"].replace(RUSD_WAM_OLD, RUSD_WAM_NEW)
        urls = {s["url"] for s in entry["sources"]}
        assert "https://docs.reservoir.xyz/products/proof-of-reserves" in urls
        entry["metricApplicability"] = {
            "weightedAverageMaturityDays": {
                "state": "unavailable",
                "rationale": RUSD_WAM_RATIONALE,
                "sourceUrl": "https://docs.reservoir.xyz/products/proof-of-reserves",
            }
        }
        report.append(f"{aid}: WAM 7.9647 -> null/unavailable (undisclosed Sentora PRIME sleeve maturities); notes WAM sentence rewritten")
    return _amend


# ---------------------------------------------------------------- group B ---

def build_alusd():
    p = packet("alusd-alchemix")
    extra = ("Merge note: branchIsolation deliberately moves from not-applicable (2026-07-20 review) to limited on "
             "re-established evidence (single shared AlchemistV2 debt system across multiple strategies; deposit caps "
             "and max-loss pauses exist but bad-strategy performance socializes through the shared alUSD debt surface); "
             "shutdownAndBadDebt stays uncurated as in the packet.")
    return simple_packet_entry("alusd-alchemix", fold=True, extra_notes=extra)


def build_btcusd(existing):
    p = packet("btcusd-btcfi")
    entry = json.loads(json.dumps(existing))
    entry["reviewedAt"] = REVIEWED_AT
    entry["metrics"]["collateralizationRatio"] = 1.308384
    entry["components"]["collateralizationParameters"] = {"quality": "limited"}
    entry["components"]["liquidationMechanics"] = {"quality": "limited"}
    urls = {s["url"] for s in entry["sources"]}
    for s in packet_sources(p):
        if s["url"] not in urls:
            entry["sources"].append(s)
            urls.add(s["url"])
    entry["notes"] = (
        "Remeasured 2026-07-27 from the issuer market API (getBtcfiMarket isTestnet=false pin, 2026-07-28): "
        "collateralizationRatio 1.308384 = total deposit value $7,974,538.63 / BtcUSD borrow value $6,094,953.39 "
        "across the market handlers (BTC-wrapped handlers 0/1/3/4 plus the BNC handler 5), down from 1.3279 on "
        "2026-07-20; DefiLlama stablecoin 183 shows ~$6.05M circulating BtcUSD near the debt print as a supply-side "
        "cross-check. BtcUSD is issued by a shared Compound/Aave-style over-collateralized lending market on the "
        "Bifrost Network (chainId 3068): users deposit BTC wrappers and native BTC and borrow BtcUSD. "
        "UNRECONCILED DISCREPANCY (carried forward from the 2026-07-20 review): the mint documentation states a "
        "maximum mint of 50% of held collateral (i.e. a 200% per-position minimum) with 5.5% loan interest, yet the "
        "observed system-wide collateralization is only ~131%; the documented 50% cap remains unreconciled with the "
        "market state (possible causes: the cap applies per-mint not to maintained positions, accrued interest, or "
        "oracle staleness). liquidationCapacityRatio remains not-applicable: liquidations are executed by external "
        "keepers repaying debt for discounted collateral and no dedicated BtcUSD-committed stability/offset pool "
        "exists in the market state. collateralizationParameters and liquidationMechanics land at limited from the "
        "2026-07-27 packet (per-collateral LTV/MCR parameter table and the full liquidation bonus/threshold schedule "
        "not dual-sourced this pass); branchIsolation (not-applicable — single shared collateral market) and "
        "structuralRedemption (limited) are retained from the 2026-07-20 review. NOT established: the exact "
        "liquidation penalty/threshold parameters, any surplus buffer or bad-debt socialization."
    )
    report.append("btcusd-btcfi: merged into existing entry; CR 1.3279->1.308384; branchIsolation+structuralRedemption retained; 50%-mint-cap caveat carried; sources unioned")
    return entry


def build_reusd_resupply():
    p = packet("reusd-resupply")
    sources = packet_sources(p)
    fixed = False
    dropped = None
    kept = []
    for s in sources:
        if "journal at finalized block 25627228" in s["label"]:
            s["label"] = s["label"].replace("finalized block 25627228", "finalized block 25627260")
            fixed = True
        if not s["url"].startswith("http"):
            dropped = s  # repo path, not a URL — inadmissible in sources
            continue
        kept.append(s)
    assert fixed and dropped
    extra = ("Merge note: liquidationCapacityRatio fell 0.100629 -> 0.079132 because the InsurancePool reUSD balance "
             "genuinely shrank (~3.24M -> ~2.55M reUSD) between the 2026-07-15 and 2026-07-27 pins — a real measured "
             "decline, not a methodology change. Prior measurement journal (method reference): "
             "shared/data/safety-score-v9/mechanism-measurements/reusd-resupply/2026-07-15-block-25536894.json "
             "(repo path, carried here because sources admit URLs only).")
    notes = fold_bases(p["notes"].rstrip() + " " + extra, p["components"])
    appl = packet_metric_applicability(p)
    report.append("reusd-resupply: replacement; source label block 25627228->25627260 fixed; non-URL journal source moved to notes; LCR decline noted")
    return packet_entry("reusd-resupply", notes, sources=kept,
                        metric_applicability=appl if appl else None)


def build_zchf(existing):
    p = packet("zchf-frankencoin")
    sources = packet_sources(p)
    audit = next(s for s in existing["sources"] if "ChainSecurity" in s["label"])
    sources.append(audit)
    appl = packet_metric_applicability(p)
    report.append("zchf-frankencoin: replacement; ChainSecurity audit source retained; packet analogousMetrics landed (reservePoolCoverage 0.365425)")
    return packet_entry("zchf-frankencoin", p["notes"].rstrip(), sources=sources,
                        metric_applicability=appl if appl else None)


def build_nbasis(existing):
    p = packet("nbasis-nest")
    sources = []
    seen = set()
    for s in packet_sources(p) + existing["sources"]:
        url = s["url"]
        if url == "https://superstate.com/uscc":
            url = "https://superstate.com/assets/uscc"
            s = {"label": s["label"] + " (redirects to /assets/uscc)", "url": url}
        if url in seen:
            continue
        seen.add(url)
        sources.append(s)
    components = packet_components(p)
    components["lossAbsorption"] = {"quality": "limited"}  # retained from existing
    appl = {
        "marginBufferPct": {
            "state": "unavailable",
            "rationale": p["metricStates"]["marginBufferPct"]["rationale"],
            "sourceUrl": p["metricStates"]["marginBufferPct"]["sourceUrl"],
        },
        "lossAbsorptionShare": {
            "state": "unavailable",
            "rationale": p["metricStates"]["lossAbsorptionShare"]["rationale"],
            "sourceUrl": p["metricStates"]["lossAbsorptionShare"]["sourceUrl"],
        },
    }
    notes = (
        "Remeasured 2026-07-27 from the Nest APIs (pin: nest-basis-vault NAV $26,361,435.37, price 1.065991, supply "
        "24,729,510.26; positions USCC ~$22,703,682 (~86.12% of NAV, slug superstate-uscc), USTB ~$1,412,092, liquid "
        "~$46,446; eth getRate accountant 1065991 matching the API price; lastPriceUpdate 2026-07-25, stale versus "
        "other Nest vaults — noted). nBASIS is a Nest BoringVault receipt over a documented allocation into the "
        "Superstate/Bitwise Crypto Carry Fund (USCC) plus Superstate USTB and a small liquid sleeve. "
        "hedgeCoverageRatio remains 1.0 as a documented-policy figure: the measured composition holds all "
        "crypto-directional exposure inside USCC, which Superstate/Bitwise documents as a market-neutral "
        "cash-and-carry fund trading through CFTC-approved CME venues, while the remainder is a T-bill fund and "
        "liquid dollars with no crypto delta; it is not a per-position hedge measurement and USCC publishes no "
        "position-level hedge state. marginBufferPct and lossAbsorptionShare move from measured-0 (2026-07-20) to "
        "unavailable — a deliberate disposition change: the prior zeros asserted a measured NAV-equals-liabilities "
        "identity and a documented structural absence of first-loss capital, but no dual-sourced zero attestation or "
        "itemized margin/insurance data exists, so both are now honestly recorded as unavailable with named search "
        "surfaces. Unwind capacity basis corrected: nBASIS carries a documented 4-day redemption estimate (Nest "
        "available-vaults) with a T+2–T+5 maximum settlement window for many strategies (Nest liquidity-and-"
        "redemptions docs); an earlier 'T+1' claim was dropped as false. The liquid sleeve is small (~0.18% of NAV). "
        "Components: venueAndCustody, hedgeReconciliation, fundingBasisStress, and unwindCapacity land at limited "
        "from the 2026-07-27 packet; lossAbsorption limited is retained from the 2026-07-20 review. NOT established: "
        "any vault-level leverage or margin framework (marginAndLiquidation stays bounded), underlying USCC "
        "position-level hedge/margin state, custodian identities inside USCC beyond issuer disclosure, and "
        "hourly-NAV reconciliation by an independent party."
    )
    entry = packet_entry(
        "nbasis-nest", notes, sources=sources, components=components,
        metric_applicability=appl,
        analogous={"navUsd": 26361435.37, "usccUsd": 22703681.7, "ustbUsd": 1412091.67,
                   "liquidUsd": 46445.66, "usccShareOfNav": 0.8612},
    )
    report.append("nbasis-nest: merged; marginBufferPct/lossAbsorptionShare measured-0 -> unavailable (deliberate, noted); unwind basis fixed to 4-day; superstate.com/uscc -> /assets/uscc; lossAbsorption retained; docs.superstate.com source kept")
    return entry


def build_nusd(existing):
    p = packet("nusd-neutrl")
    sources = packet_sources(p)
    seen = {s["url"] for s in sources}
    for s in existing["sources"]:
        if s["url"] not in seen:
            sources.append(s)
            seen.add(s["url"])
    sources.append({
        "label": "1RPC Ethereum archive RPC (alternate eth_call endpoint used for the block 25627233 re-verification after PublicNode began token-gating archive calls)",
        "url": "https://1rpc.io/eth",
    })
    components = {k: {"quality": v["quality"]} for k, v in existing["components"].items()}
    for k, v in p["components"].items():
        components[k] = {"quality": v["quality"]}
    notes = (
        "Remeasured 2026-07-27 from Neutrl's designated Accountable reserve API (snapshot ts 2026-07-27T22:41:46.555Z, "
        "verifiability 100): total reserves $61,504,400.34 against total supply $59,101,340.35 gives collateralization "
        "1.04066 and therefore marginBufferPct 4.065999 (down from 5.675083 on 2026-07-20); an eth_call totalSupply() "
        "on the NUSD token 0xe556aba6fe6036275ec1f87eda296be72c811bce at Ethereum block 25627233 "
        "(2026-07-27T22:47:47Z) returned 58,843,762.36394257 NUSD, ~0.44% below the dashboard supply (timing/coverage "
        "gap noted, not averaged into a hybrid ratio). lossAbsorptionShare is 0.04066, the same measured reserve "
        "excess over supply — the proxy caveat is carried forward: Neutrl documents a reserve fund capitalized from "
        "protocol revenue for negative-funding and margin support, but Accountable does not itemize a separate "
        "insurance/reserve-fund balance distinct from total reserves and no junior tranche or explicit first-loss "
        "pool is published. hedgeCoverageRatio = 1 remains a DOCUMENTED POLICY figure, not an observed measurement: "
        "Neutrl states collateral is deployed into delta-neutral, duration-matched strategies backed by crypto "
        "assets and liquid synthetic dollars with corresponding short futures, but no position-level net delta or "
        "hedge-notional inventory is published, and the JLP (~16.2% of reserves at the pin) and OTC Aggregate "
        "(~17.0%) buckets' hedge completeness is unverified. The venue split at the pin shows material CEX "
        "concentration (Bybit 38.74% of reserves, Binance 4.78%, OKX 0.32%) plus a 58.2% liquid Stablecoin sleeve; "
        "the 2026-07-20 venueShares snapshot is retained unchanged because the packet did not restate venue shares. "
        "NEW this review: fundingBasisStress and marginAndLiquidation land at limited — the dedicated Funding Risks "
        "and Margin Risks pages (re-opened 2026-07-27) document dynamic TVL reallocation between OTC and "
        "funding-arbitrage sleeves, a reserve fund for negative funding, real-time funding monitoring, leverage "
        "limits with alerts at a stated 50% utilization threshold, automated collateral top-ups, multi-exchange "
        "diversification, stress tests, and 24/7 coverage; the grade stays limited because no published quantitative "
        "funding-stress outputs, per-venue maintenance-margin utilization, liquidation-threshold compliance proof, "
        "or separately itemized reserve-fund balance exists, and the ~39% Bybit concentration undercuts the "
        "diversification claim. Redemption terms are unchanged: KYC/KYB-gated redemptions served from an "
        "AssetReserve instant buffer with a queued path. An archive-capable RPC (1rpc.io/eth) was added to sources "
        "because PublicNode began token-gating archive eth_call."
    )
    entry = packet_entry(
        "nusd-neutrl", notes, sources=sources, components=components,
        metrics=dict(p["metrics"]),
        analogous={"reserveToSupplyRatio": 1.04066, "assetReserveBufferShare": 0.032387},
        venue_shares=existing["venueShares"],
    )
    report.append("nusd-neutrl: merged; 3 metrics updated to 2026-07-27 remeasure; fundingBasisStress+marginAndLiquidation added; existing 4 components + venueShares retained; 1rpc.io/eth source added")
    return entry


def build_syusd(existing):
    p = packet("syusd-aegis")
    sources = packet_sources(p)
    seen = {s["url"] for s in sources}
    for s in existing["sources"]:
        if s["url"] not in seen:
            sources.append(s)
            seen.add(s["url"])
    notes = (
        "sYUSD is the yield-bearing ERC-4626 wrapper of YUSD and runs no separate hedge, so its required synthetic "
        "metrics inherit the parent YUSD evidence. Remeasured 2026-07-27 from the Aegis Accountable YUSD dashboard "
        "(snapshot data.ts 1785170794268, 2026-07-27T16:46:34Z): operating reserves $36,095,505.74 excluding the "
        "Insurance Fund against supply $35,982,081.75 gives marginBufferPct 0.315224 (aggregate excess backing, not "
        "venue margin headroom), and the separate $611,404.02 Insurance Fund gives lossAbsorptionShare 0.016992. "
        "hedgeCoverageRatio 1 records Aegis's explicitly documented policy of matching BTC spot with COIN-M futures "
        "shorts — a policy value, not a position-level observation. Historical cross-check retained from the "
        "2026-07-20 review: at finalized Ethereum block 25575027, asset() on sYUSD "
        "0xfe0ccc9942e98c963fe6b4e5194eb6e3baa4cb64 returned YUSD 0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a, "
        "totalSupply 12,352,583.012268 shares, totalAssets 12,911,668.505726 YUSD (1.045261 YUSD per share, "
        "convertToAssets matching within one wei). unwindCapacity lands at limited this review: sYUSD has a "
        "documented 7-day unstake cooldown (the docs.aegis.im sYUSD source is retained as its only pin although it "
        "currently returns 403) — a delay, not committed liquidity capacity. venueAndCustody limited (homepage names "
        "Fireblocks, Copper, CEFFU; Accountable split Copper ~72% / Fireblocks ~28% of operating reserves); "
        "hedgeReconciliation limited (Accountable aggregate USD only, not spot/futures notionals); "
        "fundingBasisStress limited (no dual-sourced quantitative funding-stress scenarios; docs.aegis.im "
        "Cloudflare-blocked at research time); lossAbsorption limited (measured Insurance Fund ~1.70% of supply). "
        "marginAndLiquidation stays uncurated: no dual-sourced maintenance-margin thresholds. NOT established: "
        "position-level net delta, hedge notionals, leverage, margin utilization, quantified stress tests, custody "
        "segregation terms, or the insurance-fund loss waterfall."
    )
    entry = packet_entry(
        "syusd-aegis", notes, sources=sources, components=packet_components(p),
        metrics=dict(p["metrics"]),
        analogous={"underlyingYusdConversionRatio": 1.045261, "wrapperBackingRatio": 1},
    )
    report.append("syusd-aegis: merged; metrics updated; unwindCapacity added; docs.aegis.im sYUSD source retained; block-25575027 pins kept in notes; marginAndLiquidation uncurated")
    return entry


def build_yusd_aegis(existing):
    p = packet("yusd-aegis")
    sources = packet_sources(p)
    seen = {s["url"] for s in sources}
    for s in existing["sources"]:
        if "docs.aegis.im" in s["url"] and s["url"] not in seen:
            sources.append(s)
            seen.add(s["url"])
    extra = ("The 2026-07-20 entry's docs.aegis.im YUSD-mechanism and Insurance Fund source entries are retained "
             "alongside the packet sources although they currently return 403 — they remain the only pins for the "
             "docs-side claims the prior review relied on.")
    notes = fold_bases(p["notes"].rstrip() + " " + extra, p["components"])
    entry = packet_entry("yusd-aegis", notes, sources=sources)
    report.append("yusd-aegis: packet values landed (metrics/analogousMetrics/venueShares); docs.aegis.im sources retained")
    return entry


def build_nwisdom():
    fix = ("4-day Nest redemption estimate (per Nest available-vaults, snapshot 2026-07-27); underlying fund is "
           "publicly traded credit vehicles with secondary market liquidity plus small nTBILL/liquid buffer. Dual "
           "Nest docs + positions. Limited WAM.")
    return simple_packet_entry("nwisdom-nest", fold=True, basis_fixes={"maturityAndLiquidity": fix})


# ---------------------------------------------------------------- journals ---

def group_a_journal(aid, d):
    return [(d["journal"]["filename"], d["journal"]["content"])]


def amend_journal_bnusd(content):
    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "facilitatorBucketWord0" and v == 9765.625:
                    node[k] = 2500000
                    yield True
                else:
                    yield from walk(v)
        elif isinstance(node, list):
            for v in node:
                yield from walk(v)
    assert any(walk(content))
    report.append("bnusd journal: facilitatorBucketWord0 9765.625 -> 2500000 (actual bucket capacity)")


def amend_journal_usdf(content):
    s = json.dumps(content)
    assert "0x6b4e267" in s
    fixed = s.replace("0x6b4e267", "0x6b4e368")
    report.append("usdf journal: block hex typo 0x6b4e267 -> 0x6b4e368")
    return json.loads(fixed)


def add_applier_note(content, note):
    content.setdefault("applierNotes", []).append(note)


def group_b_journal(aid, label):
    p = packet(aid)
    v = verdict(aid)
    vnotes = (v.get("notes") or "").strip().split("\n")[0]
    if len(vnotes) > 260:
        vnotes = vnotes[:257].rstrip() + "..."
    j = {
        "schemaVersion": 1,
        "kind": "mechanism-packet-measurement",
        "assetId": aid,
        "archetype": p["archetype"],
        "capturedAt": p.get("pinnedAt"),
        "source": f"agents/safety-score-v9/data-coverage-wave8-2026-07-27/mech-packets/{aid}.json (Grok research packet; independently re-verified)",
        "observations": {
            "pinnedAt": p.get("pinnedAt"),
            "metrics": p.get("metrics"),
        },
        "components": {k: c["quality"] for k, c in (p.get("components") or {}).items()},
        "metricDisposition": p.get("metricStates"),
        "sources": [s["url"] for s in p.get("sources", [])],
        "reVerification": {
            "by": "KIMI-MECH-2 verifier swarm",
            "date": "2026-07-27",
            "verdict": v.get("verdict"),
            "notes": vnotes,
        },
    }
    if "analogousMetrics" in p:
        j["observations"]["analogousMetrics"] = p["analogousMetrics"]  # verbatim (raw strings kept exact)
    if "venueShares" in p:
        j["observations"]["venueShares"] = p["venueShares"]
    if p.get("verification"):
        j["packetVerification"] = p["verification"]
    return [(f"2026-07-27-{label}.json", j)]


# ------------------------------------------------------------------ plan ----

def main():
    existing_file = load(OVERLAY_FILE)
    by_id = {o["assetId"]: o for o in existing_file["overlays"]}

    entries = {}   # aid -> {mode, entry}
    journals = {}  # aid -> [(filename, content)]

    def put(aid, mode, entry, jrns):
        entries[aid] = {"mode": mode, "entry": entry}
        journals[aid] = jrns

    # GROUP A
    A = [
        ("usdp-parallel", "replace", None),
        ("bnusd-balanced", "replace", None),
        ("buck-bucket-protocol", "insert", None),
        ("jpyt-dephaser", "replace", None),
        ("sbold-k3-capital", "replace", None),
        ("cdxusd-cod3x", "replace", None),
        ("usp-pikudao", "insert", None),
        ("usdf-astherus", "insert", None),
        ("asusdf-astherus", "insert", amend_asusdf),
        ("yusd-yieldfi", "replace", None),
        ("usdv-solomon", "replace", None),
        ("iauon-ondo", "insert", None),
        ("reusd-re-protocol", "insert", amend_reusd_re),
        ("apyusd-apyx", "insert", None),
        ("stcusd-cap", "replace", amend_stcusd),
        ("iusd-infinifi", "replace", None),
        ("usn-noon", "insert", amend_usn),
        ("susn-noon", "insert", None),
        ("rusd-reservoir", "insert", amend_reservoir("rusd-reservoir")),
        ("srusd-reservoir", "insert", amend_reservoir("srusd-reservoir")),
        ("fusd-freedom-dollar", "replace", None),
        ("fpi-frax", "replace", None),
    ]
    for aid, mode, amend in A:
        d, entry = group_a(aid, amend)
        assert d["mergeMode"] == mode, f"{aid}: draft mergeMode {d['mergeMode']} != expected {mode}"
        assert entry["reviewedAt"] == REVIEWED_AT, f"{aid}: reviewedAt {entry['reviewedAt']}"
        jrns = group_a_journal(aid, d)
        if aid == "bnusd-balanced":
            amend_journal_bnusd(jrns[0][1])
        if aid == "usdf-astherus":
            jrns[0] = (jrns[0][0], amend_journal_usdf(jrns[0][1]))
        if aid == "usdv-solomon":
            add_applier_note(jrns[0][1],
                "2026-07-27 applier note: docs.solomonlabs.org/usdv/usdv-and-susdv/minting-usdv and "
                "docs.solomonlabs.org/usdv/usdv-and-susdv/peg-arbitrage-mechanism now soft-404 (generic SPA shell) "
                "after Solomon's docs restructure; their content was verified via Wayback Machine captures dated "
                "2026-01-12 (web.archive.org/web/20260112171007/ and /20260112181927/).")
            report.append("usdv journal: soft-404 / Wayback 2026-01-12 durability note added")
        if aid == "usdp-parallel":
            add_applier_note(jrns[0][1],
                "2026-07-27 applier note: 0.0005 USD row-rounding nit between the summed per-asset transparency rows "
                "and the published totals; non-load-bearing, the overlay uses the published totals.")
        put(aid, mode, entry, jrns)

    # fpi raw API capture
    journals["fpi-frax"].append(("fpi-collateral-raw.json",
                                 load(os.path.join(DRAFTS, "journals", "fpi-collateral-raw.json"))))
    report.append("fpi-frax: raw API capture fpi-collateral-raw.json added to measurements dir")

    # GROUP B — special builds
    put("alusd-alchemix", "replace", build_alusd(), group_b_journal("alusd-alchemix", "block-25627228"))
    put("btcusd-btcfi", "replace", build_btcusd(by_id["btcusd-btcfi"]), group_b_journal("btcusd-btcfi", "market-api-remeasure"))
    put("reusd-resupply", "replace", build_reusd_resupply(), group_b_journal("reusd-resupply", "block-25627260"))
    put("zchf-frankencoin", "replace", build_zchf(by_id["zchf-frankencoin"]), group_b_journal("zchf-frankencoin", "block-25627132"))
    put("nbasis-nest", "replace", build_nbasis(by_id["nbasis-nest"]), group_b_journal("nbasis-nest", "nest-api-remeasure"))
    put("nusd-neutrl", "replace", build_nusd(by_id["nusd-neutrl"]), group_b_journal("nusd-neutrl", "accountable-block-25627233"))
    put("syusd-aegis", "replace", build_syusd(by_id["syusd-aegis"]), group_b_journal("syusd-aegis", "accountable-remeasure"))
    put("yusd-aegis", "replace", build_yusd_aegis(by_id["yusd-aegis"]), group_b_journal("yusd-aegis", "accountable-remeasure"))
    put("nwisdom-nest", "insert", build_nwisdom(), group_b_journal("nwisdom-nest", "nest-api"))
    report.append("nwisdom-nest: maturityAndLiquidity basis 'T+1' -> 4-day redemption estimate")

    # GROUP B — simple packet conversions
    SIMPLE = [
        ("dusd-standx", "insert", "supply-pin"),
        ("mapollo-midas", "insert", "unavailable-search"),
        ("mhyper-midas", "insert", "block-25627252"),
        ("mmev-midas", "insert", "unavailable-search"),
        ("mre7yield-midas", "insert", "unavailable-search"),
        ("susd1plus-lorenzo", "insert", "block-112517158"),
        ("inalpha-nest", "insert", "nest-api"),
        ("nopal-nest", "insert", "block-25627239"),
        ("mf-one-midas", "insert", "block-25627235"),
        ("said-gaib", "insert", "docs-capture"),
        ("usdz-anzen", "insert", "docs-capture"),
    ]
    FOLD = {"inalpha-nest", "said-gaib", "usdz-anzen"}
    for aid, mode, label in SIMPLE:
        p = packet(aid)
        has_comps = bool(p.get("components"))
        fold = aid in FOLD or (has_comps and len(p.get("notes", "")) < 600)
        put(aid, mode, simple_packet_entry(aid, fold=fold), group_b_journal(aid, label))

    # sanity: 42 entries, reviewedAt everywhere
    assert len(entries) == 42, len(entries)
    for aid, rec in entries.items():
        assert rec["entry"]["reviewedAt"] == REVIEWED_AT, aid
        assert rec["entry"]["assetId"] == aid, aid

    # batches
    BATCHES = [
        ["usdp-parallel", "bnusd-balanced", "buck-bucket-protocol", "jpyt-dephaser", "sbold-k3-capital",
         "cdxusd-cod3x", "usp-pikudao", "usdf-astherus", "asusdf-astherus"],
        ["yusd-yieldfi", "usdv-solomon", "iauon-ondo", "reusd-re-protocol", "apyusd-apyx", "stcusd-cap",
         "iusd-infinifi", "usn-noon", "susn-noon"],
        ["rusd-reservoir", "srusd-reservoir", "fusd-freedom-dollar", "fpi-frax", "alusd-alchemix",
         "btcusd-btcfi", "reusd-resupply", "zchf-frankencoin"],
        ["dusd-standx", "mapollo-midas", "mhyper-midas", "mmev-midas", "mre7yield-midas",
         "susd1plus-lorenzo", "nbasis-nest", "nusd-neutrl"],
        ["syusd-aegis", "yusd-aegis", "inalpha-nest", "nopal-nest", "nwisdom-nest", "mf-one-midas",
         "said-gaib", "usdz-anzen"],
    ]
    flat = [a for b in BATCHES for a in b]
    assert sorted(flat) == sorted(entries.keys())

    os.makedirs(STAGING, exist_ok=True)
    with open(os.path.join(STAGING, "entries.json"), "w") as f:
        json.dump({"batches": BATCHES,
                   "entries": {aid: entries[aid] for aid in flat}}, f, indent=2, ensure_ascii=False)
        f.write("\n")
    jroot = os.path.join(STAGING, "journals")
    shutil.rmtree(jroot, ignore_errors=True)
    for aid, jrns in journals.items():
        d = os.path.join(jroot, aid)
        os.makedirs(d, exist_ok=True)
        for fname, content in jrns:
            with open(os.path.join(d, fname), "w") as f:
                json.dump(content, f, indent=2, ensure_ascii=False)
                f.write("\n")

    print(f"staged {len(entries)} entries, {sum(len(v) for v in journals.values())} journal files")
    print("\n".join(report))


if __name__ == "__main__":
    main()
