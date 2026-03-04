# sync-mint-backfill-postrefactor-todo

Date: 2026-03-04

## Production deployment state

- D1 migration applied remotely: `0046_mint_burn_bridge_classification.sql`
- Worker deployed: `stablecoin-api`
- Current production version ID: `d8692b0e-1d93-48c7-b08d-67756a8eca1c`

## Post-deploy fix applied

During verification, an issue was found and fixed:

- Problem: backfill/cron used `INSERT OR IGNORE`, so already-ingested rows were not re-tagged when reprocessed.
- Fix: both cron and backfill now always run `UPDATE mint_burn_events SET burn_type, burn_review_reason` for burn rows after insert step.
- Result: targeted backfill now reclassifies existing production rows correctly (`rowsReclassified > 0` in response).

## Small-batch verification runs (ZCHF)

Config key:

- `ethereum-0xb58e61c3098d85632df34eecfb899a1ed80921cb`

Batches executed:

1. Reference CCIP tx window
- Blocks: `24576490-24576610`
- Backfill result: `rowsParsed=1, bridgeBurns=1, rowsReclassified=1`
- Verified tx: `0xdf89b2996e00265dc65d151e94638d2689c34aa407001b779f62f117b95b8e1b`
- Before: `effective_burn`
- After: `bridge_burn`

2. Additional CCIP tx window A
- Blocks: `24576270-24576370`
- Backfill result: `rowsParsed=1, bridgeBurns=1, rowsReclassified=1`
- Verified tx: `0xfe6b0af7d49a5a6c3504f217a2113514551810effc3a3fd1c85aacce2c2831d6`
- Before: `effective_burn`
- After: `bridge_burn`

3. Additional CCIP tx window B
- Blocks: `24575980-24576080`
- Backfill result: `rowsParsed=1, bridgeBurns=1, rowsReclassified=1`
- Verified tx: `0x1fb38d76fbce3f35a3b7d24bf61ce7c1075b2d7ffb77f02dcae6d86f438d6bbe`
- Before: `effective_burn`
- After: `bridge_burn`

4. Additional CCIP tx window C
- Blocks: `24576080-24576140`
- Backfill result: `rowsParsed=1, bridgeBurns=1, rowsReclassified=1`
- Verified tx: `0xd54536aa149392e116878d228d06e37e3708001c534ed8ff40265ee63e01d6dd`
- Before: `effective_burn`
- After: `bridge_burn`

5. Additional CCIP tx window D
- Blocks: `24575840-24575920`
- Backfill result: `rowsParsed=1, bridgeBurns=1, rowsReclassified=1`
- Verified tx: `0x396af5b7c2fc9f6b60efdcc91826dc1a9c8d074e6f44e9540969802076ff0308`
- Before: `effective_burn`
- After: `bridge_burn`

6. Genuine burn control window
- Blocks: `24521650-24521750`
- Backfill result: `rowsParsed=2, effectiveBurns=2, rowsReclassified=2`
- Verified txs:
  - `0xd277381b34e10023210b149a8f9ab3437b1c5e3fc08decdbbd1b8d1604cf0e62`
  - `0xf0d6c78fd7fae4b46b349a0ede71d61498325d476a52ccc54e63a8980201e1a4`
- Before: `effective_burn`
- After: `effective_burn` (unchanged)

## Verification outcomes

1. Bridge burns are excluded from supply burn accounting in hourly aggregates
- Hour `1772528400`:
  - Before targeted reclassify: `burn_count=1`, `burn_volume_usd=15967.5695`, `net_flow_usd=-15967.5695`
  - After targeted reclassify: `burn_count=0`, `burn_volume_usd=0`, `net_flow_usd=0`

2. Downstream API filter works
- `GET /api/mint-burn-events?stablecoin=226&direction=burn&burnType=bridge_burn` returns reclassified rows.

3. Data integrity checks
- Duplicate check (`id`) for ZCHF rows: `0` duplicates.
- Reclassification happened in place (`rowsInserted=0`, `rowsReclassified>0`) for already-ingested rows.

## Ethereum-only scope check

- `mint_burn_events` currently contains only `chain_id='ethereum'`.

## Affected tokens and remaining full-backfill scope

Current bridge-aware token coverage in code (`bridgeDetection` configs):

- ZCHF (`stablecoin_id=226`) only

Current production ZCHF burn classification counts:

- `total_burns=366`
- `bridge_burns=5`
- `effective_burns=361`
- `review_required=0`

Known CCIP pool burn rows (counterparty `0x9359cd75549dae00cdd8d22297bc9b13fbbe4b79`):

- Block span currently present in DB: `23040667 -> 24576551`
- Rows with this counterparty: `226`
- Reclassified as `bridge_burn`: `5`
- Remaining as `effective_burn` (pending full reprocessing): `221`

## Full historical backfill follow-up plan (next session)

1. Run full ZCHF backfill from `23040667` to latest chain head in bounded chunks.
- Suggested chunk: `50,000` blocks
- Suggested maxChunks per call: `24` (existing endpoint default)

2. After each chunk, verify:
- `bridge_burn` count monotonically increases for known CCIP pool rows.
- `effective_burn` for known CCIP pool rows decreases accordingly.
- `review_required` remains low; if it rises, inspect new router/topic patterns.

3. End-of-run validation:
- Compare `mint_burn_hourly` before/after for ZCHF high-activity hours.
- Confirm no duplicate rows (`COUNT(*) - COUNT(DISTINCT id) = 0`).
- Confirm `burnType` filtered API outputs align with DB counts.

4. Optional detector expansion backlog:
- If full backfill surfaces `review_required` rows, add new CCIP router/topic signatures and rerun targeted windows.
