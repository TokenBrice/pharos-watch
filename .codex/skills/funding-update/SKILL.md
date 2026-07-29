---
name: funding-update
description: Use when asked to update Pharos funding donations data, or on a ~weekly cadence to keep /funding current. Researches inbound transfers to the funding wallet across supported chains, resolves ENS, and appends rows to shared/data/funding/donations.json with user approval.
user_invocable: true
---

## Funding Donations Update

Weekly maintenance of the donations log that backs `/funding`. Researches new inbound transfers to the funding wallet, prices them in USD at receipt time, resolves ENS, flags spam, and after user approval, appends rows to `shared/data/funding/donations.json` and bumps `last_updated_at`.

This skill does **not** touch `shared/data/funding/costs.json`. Cost line items are a deliberate judgment call and live in a hand-edited file.

### Scope

- **Six chains:** Ethereum, Base, Optimism, Arbitrum, Polygon, Gnosis.
- **Wallet:** `0x5d698362edb8aea1c2b2483096bdee3265d860db` (ENS: `pharos-watch.eth`). Same address on every EVM chain.

### Prerequisites

- `ALCHEMY_API_KEY` present (covers 5 chains: ethereum, base, optimism, arbitrum, polygon).
- `ETHERSCAN_API_KEY` present (used for Gnosis via Etherscan's V2 unified API — chainid=100).
- `COINGECKO_API_KEY` present.

All three are in `worker/.dev.vars`.

Extended reference (edge cases, history, examples): read ./reference.md when needed.

### Process

#### Step 1 — Read current state

1. Read `shared/data/funding/donations.json`. For each of the 6 chains, record the highest `block_timestamp` seen on that chain (or `0` if the chain has no rows). Call this map `cursorsByChain`.
2. Read `shared/data/funding/costs.json` only to display the current monthly cost total to the user for context ("costs are $X/m; $Y covered so far this month") — do not edit it.

#### Step 2 — Fetch new transfers on every chain

Run the six calls in parallel (or sequentially — it's one curl per chain, the skill is not on a latency budget).

**Alchemy chains** (ethereum, base, optimism, arbitrum, polygon) — use `alchemy_getAssetTransfers`. Alchemy hostnames per chain:

| Chain | Alchemy host |
|---|---|
| ethereum | `eth-mainnet.g.alchemy.com` |
| base | `base-mainnet.g.alchemy.com` |
| optimism | `opt-mainnet.g.alchemy.com` |
| arbitrum | `arb-mainnet.g.alchemy.com` |
| polygon | `polygon-mainnet.g.alchemy.com` |

**Category support differs by chain:** Alchemy's `internal` category is only supported on **ethereum and polygon**. On base, optimism, and arbitrum, pass `["external","erc20"]` only.

```bash
# Ethereum / Polygon (include "internal")
curl -s "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
    "toAddress":"0x5d698362edb8aea1c2b2483096bdee3265d860db",
    "category":["external","internal","erc20"],
    "withMetadata":true,"excludeZeroValue":true,"order":"asc"
  }]}'

# Base / Optimism / Arbitrum (drop "internal")
curl -s "https://base-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
    "toAddress":"0x5d698362edb8aea1c2b2483096bdee3265d860db",
    "category":["external","erc20"],
    "withMetadata":true,"excludeZeroValue":true,"order":"asc"
  }]}'
```

`fromBlock` can be omitted for low-volume wallets — Alchemy returns everything from genesis and we filter by `cursorsByChain[chain]` after.

**Gnosis** — Etherscan V2 unified API with `chainid=100`. Three endpoints cover inbound native xDAI (`txlist`), ERC-20 (`tokentx`), and contract-sends (`txlistinternal`):

```bash
ADDR="0x5d698362edb8aea1c2b2483096bdee3265d860db"
for endpoint in tokentx txlist txlistinternal; do
  curl -s "https://api.etherscan.io/v2/api?chainid=100&module=account&action=${endpoint}&address=${ADDR}&startblock=0&endblock=99999999&sort=asc&apikey=$ETHERSCAN_API_KEY"
done
```

Only keep rows where `to == wallet` (txlist/txlistinternal return both directions). Drop rows with `isError == "1"`, `value == "0"`, or `type == "create"` (contract-creation traces appear in txlistinternal when a contract was deployed at the wallet address — these are not donations). If any endpoint returns `{"status":"0","message":"NOTOK","result":"Max rate limit reached"}`, wait a minute and retry — do not treat as an empty result.

For every row collected across all six chains, filter: keep only rows where `block_timestamp > cursorsByChain[chain]`. Normalize into a common shape:

- `chain`
- `tx_hash` (lowercased)
- `block_timestamp` (seconds)
- `from_address` (lowercased)
- `asset_symbol` (native symbol per chain — `ETH` on eth/base/op/arb, `MATIC` on polygon, `xDAI` on gnosis — or the ERC-20 symbol)
- `asset_address` (`null` for native; lowercased contract address for ERC-20)
- `amount_decimal` (Alchemy's `value` is already decimal-normalized; Gnosisscan returns raw string `value` that must be divided by `10 ** tokenDecimal` for tokentx, or by `1e18` for txlist/txlistinternal xDAI)

If the combined list is empty after filtering, report "No new donations since last run" and exit. No file edits.

#### Step 3 — Filter obvious spam

For each candidate, present to the user:

- `chain`, short `tx_hash`, `asset_symbol`, `amount_decimal`, short `from_address`

The user confirms which rows are real donations. Rows marked spam are discarded (not written anywhere — the skill is memoryless across runs). If the user marks every candidate spam, report that and stop — no file edits. Real rows proceed to Step 4.

#### Step 4 — Price each donation in USD at receipt

For each approved row:

- **Stablecoins** (USDC, USDT, DAI, xDAI, FRAX, LUSD): `usd_at_receipt = amount_decimal`, `price_note = "stablecoin-1-to-1"`. **Contract check first:** for ERC-20 rows, the captured `asset_address` must match that stablecoin's canonical contract on that chain (compare against `contracts[]` in `shared/data/stablecoins/coins/<id>.json`). A familiar ticker at an unknown address is a spoofed token — send it back to Step 3 as spam, never price it 1:1.
- **Native ETH / WETH:** CoinGecko `/coins/ethereum/history?date=DD-MM-YYYY` for the transfer's UTC date, read `market_data.current_price.usd`. `price_note = "coingecko-historical-YYYY-MM-DD"`.
- **Native MATIC:** CoinGecko `/coins/matic-network/history?date=DD-MM-YYYY`. `price_note = "coingecko-historical-YYYY-MM-DD"`.
- **WBTC:** CoinGecko `/coins/wrapped-bitcoin/history?date=DD-MM-YYYY`.
- **Other tokens:** ask the user for the USD value and the price source. `price_note = "manual-<brief-description>"`. Do **not** auto-resolve contract → CoinGecko id (spoofed-ticker attack).

Use the repo's existing CoinGecko auth scheme: Pro key → `https://pro-api.coingecko.com/api/v3` with `x-cg-pro-api-key` header; Demo/Analyst key → `https://api.coingecko.com/api/v3` with `x-cg-demo-api-key` header.

#### Step 5 — Resolve ENS and label donors

ENS lives on Ethereum L1 only. Look up ENS once per unique `from_address`, regardless of which chain the donation arrived on.

For each unique sender:

1. **If already present in `donations.json` on a prior row** — reuse that row's `display` value, skip lookup.
2. **If the address matches a known founder EOA** (confirm with the user on the first run; subsequent runs remember by seeing the address in the JSON with `kind: "founder"`) — set `kind: "founder"`, `display: "TokenBrice (founder subsidy)"` regardless of ENS.
3. **If the address matches a Giveth payout contract** (discovered during first Giveth test donation; same first-run confirmation flow) — set `kind: "pool"`, `display: "via Giveth"`.
4. **Otherwise** — `kind: "community"`. Look up ENS via any of these (pick whichever works — no ABI-level eth_call needed):
   - WebFetch `https://app.ens.domains/{address}` and parse the primary name shown.
   - WebFetch `https://api.ensideas.com/ens/resolve/{address}` (returns `{ name, displayName, address }`).
   - Ask the user to confirm/paste the name if the above are unavailable.

   **Forward-verify:** if a name is returned, forward-resolve it (e.g. WebFetch `https://app.ens.domains/{name}` and confirm the address matches, or ask the user to eyeball `name.eth` on Etherscan and confirm it resolves to the sender address). Only accept the name if forward-resolution matches. If anything feels off, fall back to `formatAddress(address)` — no name is better than a spoofed one.

   `display` is the verified ENS name if one exists, else `formatAddress(address)`.

#### Step 6 — Present the diff

Show the user a table of the new rows to be appended:

```
  + {chain} {tx_hash_short} {asset} {amount} → ${usd} | {display} [{kind}]
```

Flag anything uncertain:
- A `community` row with `usd > $500` — ask whether this might be the founder subsidy instead.
- An asset that required manual pricing — show the source the user gave.
- A sender with no resolved ENS — confirm it'll render as a truncated address.

If any assumption is unsafe (e.g. no confirmed founder address yet and inbound is $5k), stop and ask before writing.

#### Step 7 — Write the file

After the user approves:

1. Append each row to `donations[]` in `shared/data/funding/donations.json`, sorted by `block_timestamp` ascending relative to where it slots in (preserve oldest-first order).
2. Update `last_updated_at` to `Math.floor(Date.now() / 1000)`.
3. Save with `Edit`, not `Write` (preserve surrounding formatting).

#### Step 8 — Build and tests

```bash
npm run build 2>&1 | tail -5
npx vitest run shared/lib/funding/__tests__/helpers.test.ts
```

Expected: build completes, tests pass.

#### Step 9 — Commit

```bash
git add shared/data/funding/donations.json
git commit -m "data(funding): add {N} new donation(s) via funding-update" \
  -m "{chains covered, date range, donor mix (community/founder/pool), and anything priced manually}"
```

### Quality Standards

- Never append a row you haven't personally verified on the right explorer (Etherscan, Basescan, Polygonscan, Arbiscan, Optimism explorer, or Gnosisscan depending on chain).
- `usd_at_receipt` is priced at the **transfer's block date**, not current spot — that's what makes historical coverage % meaningful.
- ENS names must be forward-verified; an un-verified reverse record is a spoofing vector.
- Spam rows are discarded, not recorded. No denylist file to maintain.
- Never modify historical rows. If a row is wrong, ask the user before editing.
- Never touch `costs.json`.

### What NOT to Do

- Do **NOT** auto-approve rows. Every new row requires explicit user confirmation.
- Do **NOT** infer the founder address or Giveth pool address — ask on first encounter.
- Do **NOT** re-resolve ENS for addresses already in the file unless the user asks.
- Do **NOT** price unknown tokens via CoinGecko contract-lookup — ask for a manual USD value instead.
- Do **NOT** retry a rate-limited Gnosisscan response by treating it as empty — wait and retry.
