# USDai Mint/Burn Bridge Investigation

Date: 2026-04-08

## Live findings

- Production D1 rows for `usdai-usd-ai` showed recent exact-offset mint/burn pairs still classified as ordinary economic flow:
  - burn `0xaa343fdbe539a0b2e9339610a1fc6803e4f47e88e865b6376f9f1658624e671b` amount `31,745.414909`
  - mint `0x7a016b1afdfe25aa734b0dacb73cbfbbf822a3be4908bbfe8aef73e12f927e00` amount `31,745.414909`
  - burn `0x523509c92208e842a5dd55db7b0080622a5dda9be6a87a21e3abe0de7d0873de` amount `2,001,266.643486`
  - mint `0xa1aeae6a03c7ef872cfb4809e316094ffba413164f23da1b0efb350bfa866a2f` amount `2,001,266.643486`

- The recent production rows were all `flow_type='standard'`, and burns were marked `burn_type='effective_burn'`.

## On-chain evidence

- USD.AI docs state that USDai supports omnichain `burn()` / `mint()` transfers through LayerZero and that the USDai OAdapter is the bridge messaging contract.
- USD.AI contract-address docs list `USDai OAdapter = 0xffA10065Ce1d1C42FABc46e06B84Ed8FfEb4baE5`.
- The burn tx `0xaa343f...` calls selector `0xc7c7f5b3`, which resolves to `send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)`.
- The matching mint tx `0x7a016b...` calls selector `0xcfc32570`, which resolves to `execute302((address,(uint32,bytes32,uint64),bytes32,bytes,bytes,uint256))`.
- Receipts for those txs include LayerZero packet events:
  - `0x1ab700d4...` = `PacketSent(bytes,bytes,address)`
  - `0x3cd5e48f...` = `PacketDelivered((uint32,bytes32,uint64),address)`
- Receipts also include logs from the documented USDai OAdapter address `0xffa10065...`.

## Root cause

- The tracker only supported bridge classification patterns that depend on a known bridge-pool counterparty.
- USDai LayerZero OFT burns are user-initiated zero-address burns, so the parsed burn counterparty is the user wallet, not a fixed bridge pool.
- Bridge classification also ran per event-definition batch, which meant mint batches were never eligible for bridge tagging at all.
- Persistence only updated `burn_type` on replay/backfill, so even improved classification could not repair existing mint-side rows.

## Fix direction

- Add a LayerZero OFT bridge-detection mode keyed to the documented USDai OAdapter plus LayerZero packet events.
- Move bridge classification to the per-config parsed-row set so both mint and burn rows can be tagged together.
- Introduce `flow_type='bridge_transfer'` and exclude it from counted aggregates.
- Persist `flow_type` updates on replay/backfill so existing rows can be repaired after deploy.
