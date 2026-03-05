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

## Affected tokens and full-backfill status

Current bridge-aware token coverage in code (`bridgeDetection` configs):

- ZCHF (`stablecoin_id=226`) only

## Full historical backfill execution (completed 2026-03-04)

Run configuration:

- Config key: `ethereum-0xb58e61c3098d85632df34eecfb899a1ed80921cb`
- Start block: `23040667`
- Chunk size: `50,000`
- Max chunks/call: `24`

Execution summary:

1. Call #1
- Request from block: `23040667`
- Response range: `23040667 -> 24585607`
- `chunksProcessed=24`, `done=false`, `nextFromBlock=24240667`
- `rowsParsed=345`, `rowsIgnored=345`, `rowsDropped=514`
- `bridgeBurns=136`, `effectiveBurns=39`, `reviewBurns=0`
- `rowsReclassified=175`

2. Call #2
- Request from block: `24240667`
- Response range: `24240667 -> 24585610`
- `chunksProcessed=7`, `done=true`, `nextFromBlock=null`
- `rowsParsed=241`, `rowsIgnored=241`, `rowsDropped=577`
- `bridgeBurns=90`, `effectiveBurns=11`, `reviewBurns=0`
- `rowsReclassified=101`

Totals across full run:

- `rowsParsed=586`
- `rowsIgnored=586`
- `rowsDropped=1091`
- `rowsReclassified=276`

## Post-full-backfill results

1. Monotonic classification progression confirmed
- Known CCIP pool rows before full run: `bridge=5`, `effective=221`, `review=0`
- After call #1 snapshot: `bridge=141`, `effective=85`, `review=0`
- After call #2 snapshot (final): `bridge=226`, `effective=0`, `review=0`

2. Final ZCHF burn classification totals
- `total_burns=366`
- `bridge_burns=226`
- `effective_burns=140`
- `review_required=0`

3. End-of-run validation
- Duplicate check (`id`) for ZCHF rows: `0` duplicates.
- `burnType` filtered API totals align with DB:
  - `bridge_burn=226`
  - `effective_burn=140`
  - `review_required=0`
- High-activity-hour comparison (top baseline hours):
  - Hour `1764334800` changed as expected:
    - `burn_count: 3 -> 2`
    - `burn_volume_usd: 1197140.02159 -> 1172260.531706` (`-24879.489884`)
    - `net_flow_usd: 17325.397475 -> 42204.887359` (`+24879.489884`)
  - Other sampled top hours remained unchanged.

## Optional detector expansion backlog

- If future scans surface `review_required` rows, add new CCIP router/topic signatures and rerun targeted windows.
