#!/usr/bin/env python3
"""
Verify CoinGecko IDs for tracked stablecoins.

Cross-checks:
1. Our configured geckoId in shared/data/stablecoins/*.json
2. DefiLlama's gecko_id from stablecoins.llama.fi
3. CoinGecko's contract-address lookup for the Ethereum deployment

Usage:
    python3 verify.py --coin usdt-tether
    python3 verify.py --scan
    python3 verify.py --all
    python3 verify.py --coin usdt-tether --repo /abs/path/to/stablecoin-dashboard
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

CG_BASE = "https://pro-api.coingecko.com/api/v3"
CG_FREE_BASE = "https://api.coingecko.com/api/v3"
DL_BASE = "https://stablecoins.llama.fi"
STABLECOIN_DATA_FILES = [
    Path("shared/data/stablecoins/usd-major.json"),
    Path("shared/data/stablecoins/usd-minor.json"),
    Path("shared/data/stablecoins/non-usd.json"),
    Path("shared/data/stablecoins/commodity.json"),
    Path("shared/data/stablecoins/pre-launch.json"),
]


def run(cmd: list[str], timeout: int = 30) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result.stdout


def is_repo_root(path: Path) -> bool:
    return (
        (path / "shared" / "data" / "stablecoins" / "canonical-order.json").exists()
        and (path / "shared" / "lib" / "stablecoins" / "schema.ts").exists()
        and (path / "worker").exists()
    )


def detect_repo_root(explicit_repo: str | None) -> Path:
    candidates: list[Path] = []
    if explicit_repo:
        candidates.append(Path(explicit_repo).expanduser().resolve())

    cwd = Path.cwd().resolve()
    candidates.extend([cwd, *cwd.parents])

    script_dir = Path(__file__).resolve().parent
    candidates.extend([script_dir, *script_dir.parents])

    try:
        git_root = run(["git", "rev-parse", "--show-toplevel"], timeout=5).strip()
        if git_root:
            candidates.append(Path(git_root).resolve())
    except Exception:
        pass

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if is_repo_root(candidate):
            return candidate

    print("ERROR: Could not locate the stablecoin-dashboard repo root.")
    print("Run from the repo root or pass --repo /abs/path/to/stablecoin-dashboard")
    sys.exit(1)


def load_cg_key(repo_root: Path) -> str | None:
    dev_vars = repo_root / "worker" / ".dev.vars"
    if not dev_vars.exists():
        return None

    for line in dev_vars.read_text().splitlines():
        if line.strip().startswith("COINGECKO_API_KEY"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def fetch_json(url: str, api_key: str | None = None, timeout: int = 30) -> dict | list | None:
    time.sleep(0.4)
    cmd = ["curl", "-s", url]
    if api_key:
        cmd.extend(["-H", f"x-cg-pro-api-key: {api_key}"])
    try:
        raw = run(cmd, timeout=timeout).strip()
    except Exception:
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def cg_fetch(path: str, api_key: str | None) -> dict | None:
    base = CG_BASE if api_key else CG_FREE_BASE
    data = fetch_json(f"{base}{path}", api_key=api_key)
    return data if isinstance(data, dict) else None


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        print(f"ERROR: Could not read {path}: {exc}")
        sys.exit(1)


def ethereum_address(asset: dict) -> str | None:
    contracts = asset.get("contracts")
    if not isinstance(contracts, list):
        return None

    for contract in contracts:
        if not isinstance(contract, dict):
            continue
        if contract.get("chain") == "ethereum" and contract.get("address"):
            return str(contract["address"])
    return None


def load_stablecoin_assets(repo_root: Path) -> list[dict]:
    canonical_path = repo_root / "shared" / "data" / "stablecoins" / "canonical-order.json"
    canonical_order = read_json(canonical_path)
    if not isinstance(canonical_order, list):
        print(f"ERROR: {canonical_path} is not a JSON array")
        sys.exit(1)

    assets_by_id: dict[str, dict] = {}
    for rel_path in STABLECOIN_DATA_FILES:
        path = repo_root / rel_path
        assets = read_json(path)
        if not isinstance(assets, list):
            print(f"ERROR: {path} is not a JSON array")
            sys.exit(1)

        for asset in assets:
            if not isinstance(asset, dict) or not asset.get("id"):
                continue
            coin_id = str(asset["id"])
            asset = dict(asset)
            asset["_source"] = str(rel_path)
            if coin_id in assets_by_id:
                print(f"ERROR: Duplicate stablecoin ID in JSON registry: {coin_id}")
                sys.exit(1)
            assets_by_id[coin_id] = asset

    coins: list[dict] = []
    for coin_id in canonical_order:
        asset = assets_by_id.get(str(coin_id))
        if not asset:
            print(f"ERROR: canonical-order.json references unknown stablecoin ID: {coin_id}")
            sys.exit(1)

        coins.append(
            {
                "id": asset.get("id"),
                "symbol": asset.get("symbol"),
                "geckoId": asset.get("geckoId"),
                "llamaId": asset.get("llamaId"),
                "eth_address": ethereum_address(asset),
                "source": asset.get("_source"),
            }
        )

    return coins


def fetch_dl_gecko_ids() -> dict[str, dict]:
    data = fetch_json(f"{DL_BASE}/stablecoins?includePrices=true", timeout=30)
    if not isinstance(data, dict):
        return {}

    dl_map: dict[str, dict] = {}
    for coin in data.get("peggedAssets", []):
        if not isinstance(coin, dict):
            continue
        coin_id = str(coin.get("id"))
        dl_map[coin_id] = {
            "symbol": coin.get("symbol"),
            "gecko_id": coin.get("gecko_id"),
            "price": coin.get("price"),
        }
    return dl_map


def verify_coin(coin: dict, dl_gecko: str | None, api_key: str | None) -> dict:
    our_gecko = coin.get("geckoId")
    result = {
        "id": coin["id"],
        "symbol": coin["symbol"],
        "our_gecko": our_gecko,
        "dl_gecko": dl_gecko,
        "our_ok": None,
        "dl_ok": None,
        "contract_gecko": None,
        "verdict": None,
        "source": coin.get("source"),
    }

    eth_address = coin.get("eth_address")

    if our_gecko:
        our = cg_fetch(
            f"/coins/{our_gecko}?localization=false&tickers=false&community_data=false&developer_data=false",
            api_key,
        )
        if our and "id" in our:
            cg_addr = our.get("platforms", {}).get("ethereum", "")
            result["our_name"] = our.get("name")
            result["our_addr"] = cg_addr
            result["our_price"] = our.get("market_data", {}).get("current_price", {}).get("usd")
            if eth_address and cg_addr:
                result["our_ok"] = cg_addr.lower() == eth_address.lower()
            else:
                result["our_ok"] = True
        else:
            result["our_ok"] = False
            result["our_name"] = "NOT FOUND"
    else:
        result["our_ok"] = False
        result["our_name"] = "MISSING"

    if dl_gecko and dl_gecko != our_gecko:
        clean = re.sub(r"-?wrong-?", "", dl_gecko).rstrip("-")
        theirs = cg_fetch(
            f"/coins/{clean}?localization=false&tickers=false&community_data=false&developer_data=false",
            api_key,
        )
        if theirs and "id" in theirs:
            cg_addr = theirs.get("platforms", {}).get("ethereum", "")
            result["dl_name"] = theirs.get("name")
            result["dl_addr"] = cg_addr
            if eth_address and cg_addr:
                result["dl_ok"] = cg_addr.lower() == eth_address.lower()
            else:
                result["dl_ok"] = False
        else:
            result["dl_ok"] = False
            result["dl_name"] = "NOT FOUND"

    if eth_address:
        contract = cg_fetch(f"/coins/ethereum/contract/{eth_address}", api_key)
        if contract and "id" in contract:
            result["contract_gecko"] = contract.get("id")
            result["contract_name"] = contract.get("name")
            clean_dl = re.sub(r"-?wrong-?", "", dl_gecko or "").rstrip("-")
            if our_gecko and result["contract_gecko"] == our_gecko:
                result["verdict"] = "OUR_CORRECT"
            elif clean_dl and result["contract_gecko"] == clean_dl:
                result["verdict"] = "DL_CORRECT"
            elif not our_gecko:
                result["verdict"] = f"MISSING (contract={result['contract_gecko']})"
            else:
                result["verdict"] = f"NEITHER (contract={result['contract_gecko']})"
        else:
            result["verdict"] = "NOT_ON_CG"
    else:
        result["verdict"] = "NO_ETH_ADDRESS" if our_gecko else "NO_GECKO_ID"

    return result


def print_result(result: dict) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {result['id']} {result['symbol']}")
    print(f"  Source:      {result.get('source', '?')}")
    print(f"  Our geckoId: {result['our_gecko'] or '<missing>'}")
    if result["dl_gecko"]:
        print(f"  DL geckoId:  {result['dl_gecko']}")
    print(f"{'=' * 60}")

    status = "OK" if result["our_ok"] else "FAIL"
    price = result.get("our_price")
    price_str = f"${price}" if price is not None else "N/A"
    our_gecko = result["our_gecko"] or "<missing>"
    print(
        f"  [OUR]      {our_gecko:<30} -> {result.get('our_name', '?'):<30} "
        f"addr_match={status}  price={price_str}"
    )

    if result.get("dl_name"):
        status = "OK" if result["dl_ok"] else "FAIL"
        dl_gecko = result["dl_gecko"] or "<missing>"
        print(f"  [DL]       {dl_gecko:<30} -> {result['dl_name']:<30} addr_match={status}")

    if result["contract_gecko"]:
        print(f"  [CONTRACT] {result['contract_gecko']:<30} -> {result.get('contract_name', '?')}")

    verdict = result["verdict"]
    if verdict == "OUR_CORRECT":
        print("  VERDICT: Our geckoId is CORRECT")
    elif verdict == "DL_CORRECT":
        print(f"  VERDICT: DL geckoId is correct, ours is WRONG -> change to '{result['contract_gecko']}'")
    elif verdict == "NOT_ON_CG":
        print("  VERDICT: Token not found on CoinGecko (contract lookup failed)")
    elif verdict == "NO_ETH_ADDRESS":
        print("  VERDICT: No Ethereum address to verify against")
    elif verdict == "NO_GECKO_ID":
        print("  VERDICT: No geckoId configured and no Ethereum address to verify against")
    else:
        print(f"  VERDICT: {verdict}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify CoinGecko IDs for tracked stablecoins")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--coin", help="Verify a single coin by ticker-issuer ID")
    group.add_argument("--scan", action="store_true", help="Verify only DL/config mismatches")
    group.add_argument("--all", action="store_true", help="Verify all tracked coins")
    parser.add_argument("--repo", help="Absolute or relative path to the stablecoin-dashboard repo")
    args = parser.parse_args()

    repo_root = detect_repo_root(args.repo)
    api_key = load_cg_key(repo_root)
    if not api_key:
        print("WARNING: No CoinGecko API key found, using free API (rate limited)")

    coins = load_stablecoin_assets(repo_root)
    coins_by_id = {coin["id"]: coin for coin in coins}
    print(f"Loaded {len(coins)} tracked coins from {repo_root / 'shared/data/stablecoins/*.json'}")

    if args.coin:
        coin = coins_by_id.get(args.coin)
        if not coin:
            print(f"ERROR: Coin '{args.coin}' not found in tracked list")
            print("IDs use ticker-issuer format, for example: usdt-tether")
            sys.exit(1)

        dl_map = fetch_dl_gecko_ids()
        dl = dl_map.get(coin.get("llamaId", ""), {})
        print_result(verify_coin(coin, dl.get("gecko_id"), api_key))
        return

    dl_map = fetch_dl_gecko_ids()

    if args.scan:
        mismatches = []
        for coin in coins:
            llama_id = coin.get("llamaId")
            if not llama_id:
                continue
            dl = dl_map.get(llama_id, {})
            dl_gecko = dl.get("gecko_id")
            if dl_gecko and dl_gecko != coin.get("geckoId"):
                mismatches.append((coin, dl_gecko))

        if not mismatches:
            print("No geckoId mismatches found")
            return

        print(f"Found {len(mismatches)} mismatches. Verifying against CoinGecko...")
        for coin, dl_gecko in mismatches:
            print_result(verify_coin(coin, dl_gecko, api_key))
        return

    print(f"Verifying all {len(coins)} coins. This may take a while...")
    issues = []
    for index, coin in enumerate(coins, start=1):
        dl = dl_map.get(coin.get("llamaId", ""), {})
        result = verify_coin(coin, dl.get("gecko_id"), api_key)
        print_result(result)
        if result["verdict"] not in ("OUR_CORRECT", "NOT_ON_CG", "NO_ETH_ADDRESS"):
            issues.append(result)
        print(f"  [{index}/{len(coins)}]")

    if issues:
        print(f"\n{'=' * 60}")
        print(f"  ISSUES FOUND: {len(issues)}")
        print(f"{'=' * 60}")
        for result in issues:
            print(f"  {result['id']:<28} {result['symbol']:<10} {result['verdict']}")


if __name__ == "__main__":
    main()
