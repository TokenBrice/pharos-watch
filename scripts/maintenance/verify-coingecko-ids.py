#!/usr/bin/env python3
"""Fail-closed CoinGecko identity verification for tracked stablecoins."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

CG_FREE_BASE = "https://api.coingecko.com/api/v3"
CG_PRO_BASE = "https://pro-api.coingecko.com/api/v3"
DL_URL = "https://stablecoins.llama.fi/stablecoins?includePrices=true"
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
EXIT_MISMATCH = 1
EXIT_UNAVAILABLE = 2


@dataclass
class FetchResult:
    state: str
    data: Any = None
    detail: str = ""


def unavailable(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(EXIT_UNAVAILABLE)


def is_repo_root(path: Path) -> bool:
    return (
        (path / "shared/data/stablecoins/canonical-order.json").is_file()
        and (path / "shared/data/stablecoins/coins").is_dir()
        and (path / "shared/lib/stablecoins/schema.ts").is_file()
    )


def detect_repo_root(explicit: str | None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    cwd = Path.cwd().resolve()
    candidates.extend([cwd, *cwd.parents])
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            candidates.append(Path(proc.stdout.strip()).resolve())
    except (OSError, subprocess.SubprocessError):
        pass

    for candidate in dict.fromkeys(candidates):
        if is_repo_root(candidate):
            return candidate
    unavailable("ERROR: Could not locate the Pharos repository root; run from it or pass --repo.")


def parse_env_value(path: Path, name: str) -> str | None:
    if not path.is_file():
        return None
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() == name:
            parsed = value.strip().strip('"').strip("'")
            return parsed or None
    return None


def load_api_key(repo_root: Path) -> str | None:
    if os.environ.get("COINGECKO_API_KEY"):
        return os.environ["COINGECKO_API_KEY"]
    for source in (repo_root / ".env.local", repo_root / "worker/.dev.vars"):
        value = parse_env_value(source, "COINGECKO_API_KEY")
        if value:
            return value
    return None


def retry_delay(header: str | None, attempt: int) -> float:
    if header:
        try:
            return max(0.0, min(float(header), 60.0))
        except ValueError:
            try:
                parsed = parsedate_to_datetime(header)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return max(0.0, min((parsed - datetime.now(timezone.utc)).total_seconds(), 60.0))
            except (TypeError, ValueError, OverflowError):
                pass
    return min(2.0**attempt, 30.0)


def fetch_json(url: str, headers: dict[str, str] | None = None, attempts: int = 3) -> FetchResult:
    request_headers = {"Accept": "application/json", "User-Agent": "pharos-coingecko-verifier/1"}
    request_headers.update(headers or {})
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, headers=request_headers), timeout=30) as response:
                status = response.status
                raw = response.read()
            if status != 200:
                return FetchResult("unavailable", detail=f"HTTP {status}")
            try:
                return FetchResult("ok", json.loads(raw))
            except json.JSONDecodeError:
                return FetchResult("unavailable", detail="invalid JSON response")
        except HTTPError as exc:
            if exc.code == 404:
                exc.close()
                return FetchResult("not-found", detail="HTTP 404")
            retry_after = exc.headers.get("Retry-After")
            exc.close()
            if exc.code not in RETRYABLE_STATUS or attempt == attempts - 1:
                return FetchResult("unavailable", detail=f"HTTP {exc.code}")
            delay = retry_delay(retry_after, attempt)
            print(f"WARN: HTTP {exc.code}; retrying after {delay:g}s", file=sys.stderr)
            time.sleep(delay)
        except (URLError, TimeoutError, OSError) as exc:
            if attempt == attempts - 1:
                return FetchResult("unavailable", detail=f"transport error: {type(exc).__name__}")
            delay = retry_delay(None, attempt)
            print(f"WARN: transport error; retrying after {delay:g}s", file=sys.stderr)
            time.sleep(delay)
    return FetchResult("unavailable", detail="retry budget exhausted")


def cg_fetch(path: str, api_key: str | None) -> FetchResult:
    base = CG_PRO_BASE if api_key else CG_FREE_BASE
    headers = {"x-cg-pro-api-key": api_key} if api_key else None
    time.sleep(0.35)
    return fetch_json(f"{base}{path}", headers)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        unavailable(f"ERROR: Could not read {path}: {exc}")


def ethereum_address(asset: dict[str, Any]) -> str | None:
    for contract in asset.get("contracts") or []:
        if isinstance(contract, dict) and contract.get("chain") == "ethereum" and contract.get("address"):
            return str(contract["address"])
    return None


def load_assets(repo_root: Path) -> list[dict[str, Any]]:
    coin_dir = repo_root / "shared/data/stablecoins/coins"
    assets: dict[str, dict[str, Any]] = {}
    for path in sorted(coin_dir.glob("*.json")):
        asset = read_json(path)
        if not isinstance(asset, dict) or not isinstance(asset.get("id"), str):
            unavailable(f"ERROR: {path} is not a stablecoin object with a string id")
        coin_id = asset["id"]
        if coin_id in assets:
            unavailable(f"ERROR: Duplicate stablecoin id: {coin_id}")
        assets[coin_id] = {
            "id": coin_id,
            "symbol": asset.get("symbol"),
            "geckoId": asset.get("geckoId"),
            "llamaId": asset.get("llamaId"),
            "eth_address": ethereum_address(asset),
            "source": str(path.relative_to(repo_root)),
        }

    order = read_json(repo_root / "shared/data/stablecoins/canonical-order.json")
    if not isinstance(order, list) or not all(isinstance(coin_id, str) and coin_id for coin_id in order):
        unavailable("ERROR: canonical-order.json is not an array of non-empty string ids")
    if len(set(order)) != len(order):
        unavailable("ERROR: canonical-order.json contains duplicate stablecoin ids")
    missing = [coin_id for coin_id in order if coin_id not in assets]
    if missing:
        unavailable(f"ERROR: canonical-order.json references unknown id: {missing[0]}")
    return [assets[coin_id] for coin_id in order]


def clean_dl_slug(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    cleaned = value.replace("wrong-", "").replace("-wrong", "").strip("-")
    return cleaned or None


def fetch_dl_map() -> FetchResult:
    result = fetch_json(DL_URL)
    if result.state != "ok":
        return result
    if not isinstance(result.data, dict) or not isinstance(result.data.get("peggedAssets"), list):
        return FetchResult("unavailable", detail="DefiLlama payload missing peggedAssets")
    mapping = {
        str(row.get("id")): clean_dl_slug(row.get("gecko_id"))
        for row in result.data["peggedAssets"]
        if isinstance(row, dict) and row.get("id") is not None
    }
    return FetchResult("ok", mapping)


def verify_coin(coin: dict[str, Any], dl_slug: str | None, api_key: str | None) -> dict[str, str | None]:
    configured = coin.get("geckoId") if isinstance(coin.get("geckoId"), str) else None
    address = coin.get("eth_address")
    result: dict[str, str | None] = {
        "id": str(coin["id"]),
        "symbol": str(coin.get("symbol") or "?"),
        "configured": configured,
        "defillama": dl_slug,
        "resolved": None,
        "status": None,
        "detail": None,
        "source": str(coin.get("source") or "?"),
    }

    if not address:
        if not configured:
            result.update(status="UNAVAILABLE", detail="no geckoId and no Ethereum contract")
            return result
        slug_result = cg_fetch(f"/coins/{quote(configured, safe='')}", api_key)
        if slug_result.state == "ok" and isinstance(slug_result.data, dict) and slug_result.data.get("id") == configured:
            result.update(status="UNAVAILABLE", detail="configured slug resolves, but no Ethereum contract proves identity")
        elif slug_result.state == "not-found":
            result.update(status="MISMATCH", detail="configured slug does not resolve")
        else:
            result.update(status="UNAVAILABLE", detail=slug_result.detail or "CoinGecko slug lookup unavailable")
        return result

    lookup = cg_fetch(f"/coins/ethereum/contract/{quote(str(address), safe='')}", api_key)
    if lookup.state == "not-found":
        result.update(status="UNAVAILABLE", detail="Ethereum contract is not indexed by CoinGecko")
        return result
    if lookup.state != "ok" or not isinstance(lookup.data, dict) or not isinstance(lookup.data.get("id"), str):
        result.update(status="UNAVAILABLE", detail=lookup.detail or "contract lookup returned no identity")
        return result

    resolved = lookup.data["id"]
    result["resolved"] = resolved
    if configured == resolved:
        result.update(status="MATCH", detail="configured geckoId matches the Ethereum contract lookup")
    elif not configured:
        result.update(status="MISMATCH", detail=f"missing geckoId; contract resolves to {resolved}")
    elif dl_slug == resolved:
        result.update(status="MISMATCH", detail=f"configured geckoId differs; DefiLlama and contract resolve to {resolved}")
    else:
        result.update(status="MISMATCH", detail=f"configured geckoId differs; contract resolves to {resolved}")
    return result


def print_result(result: dict[str, str | None]) -> None:
    print(
        f"{result['status']}: {result['id']} ({result['symbol']}) "
        f"configured={result['configured'] or '<missing>'} "
        f"defillama={result['defillama'] or '<missing>'} "
        f"contract={result['resolved'] or '<unresolved>'}"
    )
    print(f"  {result['detail']} [{result['source']}]")


def exit_for(results: list[dict[str, str | None]]) -> int:
    mismatches = sum(result["status"] == "MISMATCH" for result in results)
    unavailable = sum(result["status"] == "UNAVAILABLE" for result in results)
    matches = sum(result["status"] == "MATCH" for result in results)
    print(f"SUMMARY: match={matches} mismatch={mismatches} unavailable={unavailable}")
    if mismatches:
        return EXIT_MISMATCH
    if unavailable:
        return EXIT_UNAVAILABLE
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify tracked geckoId values against DefiLlama and CoinGecko contract identity.",
        epilog="Exit 0: all selected identities match; 1: identity mismatch; 2: repository/input failure or verification unavailable.",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--coin", help="Verify one canonical ticker-issuer id")
    group.add_argument("--scan", action="store_true", help="Verify only DefiLlama/config mismatches")
    group.add_argument("--all", action="store_true", help="Verify every tracked coin")
    parser.add_argument("--repo", help="Repository root (auto-detected by default)")
    args = parser.parse_args()

    repo_root = detect_repo_root(args.repo)
    assets = load_assets(repo_root)
    by_id = {asset["id"]: asset for asset in assets}

    if args.coin and args.coin not in by_id:
        print(f"ERROR: Unknown stablecoin id: {args.coin}", file=sys.stderr)
        return EXIT_UNAVAILABLE

    api_key = load_api_key(repo_root)
    print(f"CoinGecko authentication: {'configured' if api_key else 'free API (rate limited)'}")

    dl_result = fetch_dl_map()
    if dl_result.state != "ok":
        print(f"UNAVAILABLE: DefiLlama metadata fetch failed ({dl_result.detail})", file=sys.stderr)
        return EXIT_UNAVAILABLE
    dl_map: dict[str, str | None] = dl_result.data

    if args.coin:
        selected = [by_id[args.coin]]
    elif args.scan:
        selected = [
            coin
            for coin in assets
            if coin.get("llamaId")
            and dl_map.get(str(coin["llamaId"]))
            and dl_map.get(str(coin["llamaId"])) != coin.get("geckoId")
        ]
        if not selected:
            print("SUMMARY: no DefiLlama/config geckoId mismatches found")
            return 0
    else:
        selected = assets

    results = []
    for coin in selected:
        llama_id = str(coin["llamaId"]) if coin.get("llamaId") is not None else ""
        result = verify_coin(coin, dl_map.get(llama_id), api_key)
        print_result(result)
        results.append(result)
    return exit_for(results)


if __name__ == "__main__":
    sys.exit(main())
