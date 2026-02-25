#!/usr/bin/env python3
"""
CoinGecko ID Verification Script

Cross-references geckoIds from src/lib/stablecoins.ts against CoinGecko's
contract-address lookup to verify correctness.

Usage:
    python3 verify.py --coin 269           # Verify single coin by DL id
    python3 verify.py --scan               # Scan for DL vs our config mismatches
    python3 verify.py --all                # Full audit of all tracked coins
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
STABLECOINS_TS = os.path.join(REPO_ROOT, "src", "lib", "stablecoins.ts")
DEV_VARS = os.path.join(REPO_ROOT, "worker", ".dev.vars")

CG_BASE = "https://pro-api.coingecko.com/api/v3"
CG_FREE_BASE = "https://api.coingecko.com/api/v3"
DL_BASE = "https://stablecoins.llama.fi"


def load_cg_key() -> str | None:
    """Load CoinGecko API key from worker/.dev.vars."""
    if not os.path.exists(DEV_VARS):
        return None
    with open(DEV_VARS) as f:
        for line in f:
            if line.strip().startswith("COINGECKO_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"')
    return None


def cg_fetch(path: str, api_key: str | None) -> dict | None:
    """Fetch from CoinGecko API with rate limiting."""
    time.sleep(0.4)
    base = CG_BASE if api_key else CG_FREE_BASE
    headers = ["-H", f"x-cg-pro-api-key: {api_key}"] if api_key else []
    result = subprocess.run(
        ["curl", "-s", f"{base}{path}"] + headers,
        capture_output=True,
        text=True,
    )
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def parse_stablecoins_ts() -> list[dict]:
    """Parse stablecoins.ts to extract id, symbol, geckoId, and eth contract address."""
    with open(STABLECOINS_TS) as f:
        content = f.read()

    coins = []
    lines = content.split("\n")
    current_id = None
    current_symbol = None
    current_gecko = None
    current_contracts: list[dict] = []
    in_contracts = False
    brace_depth = 0

    for line in lines:
        # Match function calls: usd("ID", "Name", "SYMBOL", ...)
        m = re.match(
            r'\s*(?:usd|eur|other|coin)\("([^"]+)",\s*"[^"]+",\s*"([^"]+)"', line
        )
        if m:
            # Save previous coin if any
            if current_id and current_gecko:
                eth_addr = None
                for c in current_contracts:
                    if c.get("chain") == "ethereum":
                        eth_addr = c.get("address")
                        break
                coins.append(
                    {
                        "id": current_id,
                        "symbol": current_symbol,
                        "geckoId": current_gecko,
                        "eth_address": eth_addr,
                    }
                )
            current_id = m.group(1)
            current_symbol = m.group(2)
            current_gecko = None
            current_contracts = []

        # Match geckoId
        m2 = re.search(r'geckoId:\s*"([^"]+)"', line)
        if m2 and current_id:
            current_gecko = m2.group(1)

        # Match contract entries
        m3 = re.search(
            r'\{\s*chain:\s*"([^"]+)",\s*address:\s*"([^"]+)"', line
        )
        if m3 and current_id:
            current_contracts.append(
                {"chain": m3.group(1), "address": m3.group(2)}
            )

    # Save last coin
    if current_id and current_gecko:
        eth_addr = None
        for c in current_contracts:
            if c.get("chain") == "ethereum":
                eth_addr = c.get("address")
                break
        coins.append(
            {
                "id": current_id,
                "symbol": current_symbol,
                "geckoId": current_gecko,
                "eth_address": eth_addr,
            }
        )

    return coins


def fetch_dl_gecko_ids() -> dict[str, dict]:
    """Fetch geckoIds from DefiLlama stablecoins list."""
    result = subprocess.run(
        ["curl", "-s", f"{DL_BASE}/stablecoins?includePrices=true"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    data = json.loads(result.stdout)
    dl_map = {}
    for coin in data.get("peggedAssets", []):
        dl_map[str(coin.get("id"))] = {
            "symbol": coin.get("symbol"),
            "gecko_id": coin.get("gecko_id"),
            "price": coin.get("price"),
        }
    return dl_map


def verify_coin(
    coin: dict, dl_gecko: str | None, dl_price: float | None, api_key: str | None
) -> dict:
    """Verify a single coin's geckoId. Returns a result dict."""
    result = {
        "id": coin["id"],
        "symbol": coin["symbol"],
        "our_gecko": coin["geckoId"],
        "dl_gecko": dl_gecko,
        "dl_price": dl_price,
        "our_ok": None,
        "dl_ok": None,
        "contract_gecko": None,
        "verdict": None,
    }

    eth_address = coin.get("eth_address")

    # Check 1: Our geckoId
    d1 = cg_fetch(
        f"/coins/{coin['geckoId']}?localization=false&tickers=false&community_data=false&developer_data=false",
        api_key,
    )
    if d1 and "id" in d1:
        cg_addr = d1.get("platforms", {}).get("ethereum", "")
        result["our_name"] = d1.get("name")
        result["our_addr"] = cg_addr
        result["our_price"] = (
            d1.get("market_data", {}).get("current_price", {}).get("usd")
        )
        if eth_address and cg_addr:
            result["our_ok"] = cg_addr.lower() == eth_address.lower()
        else:
            result["our_ok"] = True  # can't verify without address
    else:
        result["our_ok"] = False
        result["our_name"] = "NOT FOUND"

    # Check 2: DL geckoId (if different)
    if dl_gecko and dl_gecko != coin["geckoId"]:
        clean = re.sub(r"-?wrong-?", "", dl_gecko).rstrip("-")
        d2 = cg_fetch(
            f"/coins/{clean}?localization=false&tickers=false&community_data=false&developer_data=false",
            api_key,
        )
        if d2 and "id" in d2:
            cg_addr2 = d2.get("platforms", {}).get("ethereum", "")
            result["dl_name"] = d2.get("name")
            result["dl_addr"] = cg_addr2
            if eth_address and cg_addr2:
                result["dl_ok"] = cg_addr2.lower() == eth_address.lower()
            else:
                result["dl_ok"] = False
        else:
            result["dl_ok"] = False
            result["dl_name"] = "NOT FOUND"

    # Check 3: Contract address ground truth
    if eth_address:
        d3 = cg_fetch(f"/coins/ethereum/contract/{eth_address}", api_key)
        if d3 and "id" in d3:
            result["contract_gecko"] = d3.get("id")
            result["contract_name"] = d3.get("name")

            if result["contract_gecko"] == coin["geckoId"]:
                result["verdict"] = "OUR_CORRECT"
            elif dl_gecko and result["contract_gecko"] == re.sub(
                r"-?wrong-?", "", dl_gecko
            ).rstrip("-"):
                result["verdict"] = "DL_CORRECT"
            else:
                result["verdict"] = f"NEITHER (contract={result['contract_gecko']})"
        else:
            result["verdict"] = "NOT_ON_CG"
    else:
        result["verdict"] = "NO_ETH_ADDRESS"

    return result


def print_result(r: dict) -> None:
    """Pretty-print a verification result."""
    print(f"\n{'=' * 60}")
    print(f"  {r['id']} {r['symbol']}")
    print(f"  Our geckoId: {r['our_gecko']}")
    if r["dl_gecko"]:
        print(f"  DL geckoId:  {r['dl_gecko']}")
    print(f"{'=' * 60}")

    # Our geckoId
    status = "OK" if r["our_ok"] else "FAIL"
    name = r.get("our_name", "?")
    addr = r.get("our_addr", "N/A")
    price = r.get("our_price")
    price_str = f"${price}" if price else "N/A"
    print(f"  [OUR]      {r['our_gecko']:<30} -> {name:<30} addr_match={status}  price={price_str}")

    # DL geckoId
    if r.get("dl_name"):
        status2 = "OK" if r["dl_ok"] else "FAIL"
        print(
            f"  [DL]       {r['dl_gecko']:<30} -> {r['dl_name']:<30} addr_match={status2}"
        )

    # Contract ground truth
    if r["contract_gecko"]:
        print(f"  [CONTRACT] {r.get('contract_gecko', 'N/A'):<30} -> {r.get('contract_name', '?')}")

    # Verdict
    verdict = r["verdict"]
    if verdict == "OUR_CORRECT":
        print(f"  VERDICT: Our geckoId is CORRECT")
    elif verdict == "DL_CORRECT":
        print(
            f"  VERDICT: DL geckoId is correct, ours is WRONG -> change to '{r['contract_gecko']}'"
        )
    elif verdict == "NOT_ON_CG":
        print(f"  VERDICT: Token not found on CoinGecko (contract lookup failed)")
    elif verdict == "NO_ETH_ADDRESS":
        print(f"  VERDICT: No Ethereum address to verify against")
    else:
        print(f"  VERDICT: {verdict}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify CoinGecko IDs for tracked stablecoins")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--coin", help="Verify a single coin by DefiLlama ID")
    group.add_argument(
        "--scan",
        action="store_true",
        help="Scan for geckoId mismatches between our config and DefiLlama",
    )
    group.add_argument(
        "--all", action="store_true", help="Verify all tracked coins (slow)"
    )
    args = parser.parse_args()

    api_key = load_cg_key()
    if not api_key:
        print("WARNING: No CoinGecko API key found, using free API (rate limited)")

    coins = parse_stablecoins_ts()
    coins_by_id = {c["id"]: c for c in coins}

    print(f"Loaded {len(coins)} tracked coins from stablecoins.ts")

    if args.coin:
        coin = coins_by_id.get(args.coin)
        if not coin:
            print(f"ERROR: Coin '{args.coin}' not found in tracked list")
            sys.exit(1)
        dl_map = fetch_dl_gecko_ids()
        dl = dl_map.get(args.coin, {})
        r = verify_coin(coin, dl.get("gecko_id"), dl.get("price"), api_key)
        print_result(r)

    elif args.scan:
        print("Fetching DefiLlama geckoIds...")
        dl_map = fetch_dl_gecko_ids()

        mismatches = []
        for coin in coins:
            if coin["id"].startswith("cg-"):
                continue
            dl = dl_map.get(coin["id"], {})
            dl_gecko = dl.get("gecko_id")
            if dl_gecko and dl_gecko != coin["geckoId"]:
                mismatches.append((coin, dl_gecko, dl.get("price")))

        if not mismatches:
            print("No geckoId mismatches found!")
            return

        print(f"\nFound {len(mismatches)} mismatches. Verifying against CoinGecko...\n")
        for coin, dl_gecko, dl_price in mismatches:
            r = verify_coin(coin, dl_gecko, dl_price, api_key)
            print_result(r)

    elif args.all:
        print("Fetching DefiLlama geckoIds...")
        dl_map = fetch_dl_gecko_ids()
        print(f"Verifying all {len(coins)} coins (this will take a while)...\n")

        issues = []
        for i, coin in enumerate(coins):
            dl = dl_map.get(coin["id"], {})
            r = verify_coin(coin, dl.get("gecko_id"), dl.get("price"), api_key)
            print_result(r)
            if r["verdict"] not in ("OUR_CORRECT", "NOT_ON_CG", "NO_ETH_ADDRESS"):
                issues.append(r)
            # Progress
            print(f"  [{i + 1}/{len(coins)}]")

        if issues:
            print(f"\n{'=' * 60}")
            print(f"  ISSUES FOUND: {len(issues)}")
            print(f"{'=' * 60}")
            for r in issues:
                print(f"  {r['id']:>5} {r['symbol']:<10} {r['verdict']}")


if __name__ == "__main__":
    main()
