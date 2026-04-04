# Live vs Proof Reserve Badge Assessment

Date: 2026-04-04

## Scope

Investigate whether the current `Live` / `Proof` reserve-label model incorrectly downgrades directly observable on-chain reserves, with LUSD as the motivating example.

## Findings

1. The system already distinguishes evidence quality from UI badge text.
   - Badge mapping lives in `shared/lib/live-reserve-display.ts`.
   - Evidence quality lives in `shared/lib/live-reserve-adapters.ts` via `evidenceClass`.
   - Strong on-chain single-bucket feeds are already allowed to show as `Live` when their adapter is classified as `independent` (`chainlink-nav`, `chainlink-por`, `erc4626-single-asset`, `btcfi`, `sgforge-coinvertible`).

2. `Proof` is currently the presentation for `weak-live-probe`, not for all single-bucket/on-chain evidence.
   - Docs explicitly describe `single-asset` and `tether` as weak probe families.
   - Frontend copy for `Proof` says it reflects a proof, attestation, or liveness check rather than a full live reserve composition feed.

3. LUSD is not currently using a true reserve-observation adapter.
   - `lusd-liquity` is configured with adapter `single-asset` and `inputs.primary.kind = "onchain-evm"`.
   - In on-chain mode, `single-asset` only probes token total supply and optional redemption fee metadata.
   - It does not read Liquity v1 collateral balances or branch/pool state.
   - Metadata for this path is stamped as `proofKind: "erc20-total-supply-liveness"`.

4. Therefore LUSD's current `Proof` label is accurate for the implementation, but not for the protocol's theoretical observability.
   - The protocol is decentralized and its reserves should be derivable on-chain.
   - The current adapter simply does not perform that derivation.

5. Local inventory result:
   - `Proof`-badged live-reserve coins: 49 total.
   - 48 use `single-asset`; 1 uses `tether`.
   - Among decentralized live-enabled coins, LUSD is the only one currently landing in `Proof`.
   - Most `Proof` coins are centralized RWA-backed single-asset configs whose current path is also just a weak single-bucket probe, not a direct reserve composition read.

## Assessment

The current taxonomy is directionally correct:

- If the system has a genuinely direct on-chain reserve read, it should be highest trust and can already surface as `Live`.
- If the system only has liveness, coarse attestation, or a one-bucket proof without direct reserve-state observation, `Proof` is the honest label.

The LUSD issue is not a badge-policy bug first. It is an adapter-capability gap.

## Recommendation

1. Do not globally remap `single-asset` from `Proof` to `Live`.
   - That would incorrectly promote many weak issuer/liveness probes.

2. Promote coins to `Live` only when the adapter performs real reserve-state observation.
   - For decentralized coins: direct contract/accounting reads.
   - For CeFi-dependent coins: direct on-chain collateral balances, on-chain validator/PoR state, or similarly strong independently checkable state.

3. First candidate for upgrade: LUSD.
   - Add a dedicated Liquity v1 reserve adapter that reads actual collateral state from protocol contracts.
   - Once that exists, classify the adapter as `independent` and map it to `Live`.

4. After LUSD, review the other `single-asset` coins individually.
   - Some may deserve stronger adapters.
   - Many will still belong in `Proof` because the current signal is only attestation/liveness, not reserve observation.

## Practical Next Step

Build a dedicated Liquity v1 adapter rather than changing badge text or remapping `single-asset`.
