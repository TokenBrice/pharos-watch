"""Offline catalog admission and identity-selection regressions."""

import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "verify_coingecko_ids", Path(__file__).resolve().parents[1] / "verify-coingecko-ids.py"
)
verifier = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = verifier
spec.loader.exec_module(verifier)


class VerifyCoinGeckoIdsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.coins = self.root / "shared/data/stablecoins/coins"
        self.coins.mkdir(parents=True)
        schema = self.root / "shared/lib/stablecoins/schema.ts"
        schema.parent.mkdir(parents=True)
        schema.touch()
        for coin_id, contracts in [
            ("first-usd", [{"chain": "ethereum", "address": "0x" + "1" * 40}]),
            ("second-usd", [{"chain": "solana", "address": "non-ethereum-contract"}]),
        ]:
            (self.coins / f"{coin_id}.json").write_text(json.dumps({
                "id": coin_id, "symbol": coin_id, "geckoId": coin_id,
                "llamaId": coin_id, "contracts": contracts,
            }), encoding="utf-8")
        self.order = self.coins.parent / "canonical-order.json"
        self.order.write_text(json.dumps(["second-usd", "first-usd"]), encoding="utf-8")

    def assert_catalog_unavailable(self, order, message):
        self.order.write_text(json.dumps(order), encoding="utf-8")
        for selection in (["--all"], ["--scan"], ["--coin", "first-usd"]):
            with self.subTest(selection=selection), patch.object(
                sys, "argv", ["verify-coingecko-ids.py", "--repo", str(self.root), *selection]
            ), patch.object(verifier, "fetch_dl_map") as dl_fetch, patch.object(
                verifier, "cg_fetch"
            ) as cg_fetch, redirect_stderr(io.StringIO()) as stderr:
                with self.assertRaises(SystemExit) as error:
                    verifier.main()
                self.assertEqual(error.exception.code, 2)
                self.assertIn(message, stderr.getvalue())
                dl_fetch.assert_not_called()
                cg_fetch.assert_not_called()

    def test_extra_base_id(self):
        self.assert_catalog_unavailable(["first-usd"], "second-usd")

    def test_unknown_order_id(self):
        self.assert_catalog_unavailable(["first-usd", "unknown-usd"], "references unknown id: unknown-usd")

    def test_duplicate_order_id(self):
        self.assert_catalog_unavailable(["first-usd", "first-usd"], "contains duplicate stablecoin ids")

    def test_exact_set_equality(self):
        self.assertEqual(
            [coin["id"] for coin in verifier.load_assets(self.root)],
            ["second-usd", "first-usd"],
        )

    def test_selection_and_exit_precedence(self):
        dl_map = {"first-usd": "corrected-usd", "second-usd": "second-usd"}
        cases = [
            (["--all"], "corrected-usd", 1, 2),
            (["--scan"], "corrected-usd", 1, 1),
            (["--coin", "first-usd"], "first-usd", 0, 1),
            (["--coin", "second-usd"], "second-usd", 2, 1),
        ]
        for selection, resolved, expected_exit, expected_calls in cases:
            with self.subTest(selection=selection), patch.object(
                sys, "argv", ["verify-coingecko-ids.py", "--repo", str(self.root), *selection]
            ), patch.object(verifier, "load_api_key", return_value=None), patch.object(
                verifier, "fetch_dl_map", return_value=verifier.FetchResult("ok", dl_map)
            ), patch.object(
                verifier, "cg_fetch",
                side_effect=lambda path, key: verifier.FetchResult(
                    "ok", {"id": resolved if "/contract/" in path else "second-usd"}
                ),
            ) as cg_fetch, redirect_stdout(io.StringIO()):
                self.assertEqual(verifier.main(), expected_exit)
                self.assertEqual(cg_fetch.call_count, expected_calls)
                if selection == ["--coin", "second-usd"]:
                    self.assertEqual(cg_fetch.call_args.args[0], "/coins/second-usd")


if __name__ == "__main__":
    unittest.main()
