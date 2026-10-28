# Blacklist Tracker

FreezeWatch tracks observed stablecoin blacklist, freeze, release and destroy events across supported deployments. Scans run every six hours. Observed history, current control exposure and last-known frozen balances answer different questions; none is a probability of a future freeze.

## Methodology And Ownership

- **Current methodology version:** <!-- GENERATED-START: methodology-version-blacklist-tracker -->`v4.61`<!-- GENERATED-END: methodology-version-blacklist-tracker -->
- **Public changelog:** [Blacklist Tracker history](https://pharos.watch/methodology/blacklist-tracker-changelog/)

## Public Exposure Contract

FreezeWatch uses four reviewed exposure classes: **Yes**, **Possible**, **Upstream**, and **No**. These describe holder-control exposure, not an observed freeze or its likelihood. A direct verdict takes precedence over upstream exposure. Retracting an observed event does not change issuer-control exposure.

### FreezeWatch Decision Procedure

1. **Measure material deployments first.** Use each deployment's share of circulating supply against
   the Safety Score policy’s materiality threshold (currently ≥10%).
   If a share is missing, measure deployment supply against the asset total with pinned observations
   before failing closed. A share that still cannot be established is treated as material and flagged.
   Materiality is per deployment: never sum individually sub-threshold deployments to set a verdict,
   even under one controller. Disclose their controls and combined share without changing the status.
2. **Yes: a current holder-targeted control on a material deployment.** This includes blacklist,
   address freeze, seizure, forced transfer, allowlist-gated transfers, enforced sanctions/denylist
   oracles, active holder-targeted wrapper/savings-share redemption or withdrawal gates, chain-native freeze/clawback/KYC keys,
   and privileged burns from arbitrary holders. Verify the current implementation and at least one
   current, non-renounced authority or role member whose reachable code can target arbitrary holders;
   an empty blacklist or no past exercise does not negate an assigned power. An admin that can grant
   the denylist-state role or set the denylist flag directly on a victim already has that power,
   even if an intermediate blacklist-manager role is empty.
   A wrapper that can impose or reimpose locks on existing balances without holder consent is also
   Yes, including a `wrapAndLock` path that revives persistent locks.
   A Solana/SPL freeze authority or permanent delegate is a current member only when its holder can
   sign today (a keypair, SPL multisig or Squads-style vault). A program PDA qualifies only if the
   current program exposes an admin-callable freeze/seize instruction. Otherwise that authority
   supplies only upgrade exposure: Possible if the program is upgradeable, not an active Yes control.
3. **Possible: no Yes, but a direct holder-facing surface on a material deployment.** This includes
   a global transfer pause without address targeting; any admin- or DAO-upgradeable token
   implementation, regardless of delay; an empty/incapable burner or blacklist-operator role that an
   admin/governor can populate with an arbitrary-holder-capable operator; a dormant configurable
   transfer or wrapper/savings exit gate, or unenforced sanctions oracle with a live setter; an upgradeable canonical
   bridge's holder-burn surface; and qualifying chain-consensus interventions able to halt transfers.
   Chain-consensus Possible is limited to interventions shipped by the issuer, interventions on a
   chain the issuer controls (such as Zephyr or Hive/HBD), or host-chain changes specifically targeting
   the asset or its holders. Generic L1 upgradeability and third-party host-chain-wide rollbacks
   do not count.
   A wrapper/savings share whose own redeem/withdraw path can be globally paused is also Possible,
   on the same footing as a global transfer pause, only when its value is the redemption claim on
   wrapped underlying. This does not extend to a primary stablecoin's redemption rails.
   A current burner whose code reaches only itself, callers or protocol pools is not an arbitrary-holder
   burner. Granting an operator first is Possible; directly assigning a victim's denylist state is Yes.
   The DAO carve-out below applies only to collateral, never to the token's own upgradeability.
4. **Upstream: no direct Yes/Possible, and a qualifying parent or reserve basis.** A holder claim
   inherits a declared parent (`variantOf` or `mintAuthority.inheritedFrom`) whose reviewed status is
   Yes, Possible or Upstream. Full CEX custody of reserves also qualifies. Otherwise, **strictly >50%**
   of measured external backing must terminate in issuer/custodian control under the test below.
5. **No: none of those tests establishes exposure.** Deposit/entry-only gates and caps, permanently
   abdicated setters, mint-only authority, and increase-only rebases are not holder-facing controls.
   While a primary stablecoin transfers freely, its redemption rails (PSMs, issuer redemption desks,
   and CDP/synthetic protocol mint-withdraw paths), protocol-global redemption switches and peripheral
   swap-facility switches are not holder-facing. A bridge/OFT pause that gates only cross-chain
   send/receive is not a transfer pause. An immutable burner set with no arbitrary-holder-capable
   member and a renounced admin supplies no direct control. Unmeasurable reserves never establish
   Upstream: exhaust the direct-control review, disclose `UNRESOLVED-RESERVE:` and low confidence if
   the remaining verdict is No, rather than asserting absence of upstream risk.

**Reserve test.** Count issuer-freezable tokens, custodian-pausable wrappers, CEX custody, and
custodial fiat, bank deposits, fund-manager/fund claims, T-bills and allocated physical commodity at
a custodian/vault operator. A collateral slice counts at its full value when its correct Yes,
Possible or Upstream basis terminates in issuer/custodian control; nested exposure is categorical,
not pro-rated by the collateral token's own exposed fraction. DAO/protocol-governance-only collateral
(including DAO-only upgrades/pauses and LSTs such as stETH/wstETH or jitoSOL) does not count.
For CDP/lending coins, weight each market's debt by the qualifying value fraction of its collateral;
reserve-backed coins use published reserve composition. Split LP/basket rows by constituent value.
Exclude the coin and its own wrappers/savings shares from both numerator and denominator: they are
not external backing. Different tokens from the same issuer count at their own status.
State the denominator and qualifying percentage; give pro-rated or alternative-denominator
sensitivities when they would change the >50% result, without substituting them for the primary metric.

**Evidence.** Name the reviewed deployments, supply shares and observation dates; cite verified
source/implementation and pin chain, block, timestamp, call and result for decisive live reads.
Identify role members, reachable holder-targeting paths, upgrade/setter authority and oracle
enforcement, not merely role names or governance labels. Name any parent and claim relationship,
or CEX/custodian and reserve components, metric, denominator and measured percentage. A No review
explicitly addresses direct controls on every material deployment, parent and reserve tests.
Retain peripheral controls and unresolved facts as qualifications; missing/failed reads and
centralized-governance metadata alone prove neither an active Yes control nor reserve-majority exposure.
The detail card's `Not freezable` note and quick answers describe this materiality-scoped verdict,
not an absence of controls on every peripheral deployment.

## Event And Coverage Rules

Event counts describe supported observed history. They are symbol-level counts, not contract-level totals; scan coverage is assessed separately for each deployment. An active listing or reviewed freeze verdict does not itself establish event-tracker coverage. Unsupported or non-emitting deployments cannot establish that no intervention occurred.

Canonical account/log identities count once. Batch events expand to individual affected addresses. Invalid addresses, event fields or identities cannot become default freezes. Tron account spellings normalize to the same validated byte identity; transaction hashes alone never establish execution order.

Conflicting Tron effects without proven transaction positions remain ambiguous. They are excluded from confirmed active-state counts and balance-capture candidates until ordering is proved. Same-direction repetition is unambiguous; a later ordered transition may resolve state. Freeze-then-destroy records destroyed funds, not active frozen value.

### Amount evidence

An emitted destroy or seize amount is preferred. A preceding-block balance cannot prove an amountless event's historical quantity because transfers or wipes in the same block may change it. Amountless EVM freezes and releases remain unavailable; a burn-shaped transfer alone cannot prove a wipe amount. Missing amounts never become zero, and the event remains in history.

Confirmed Tron transfer replay can reconstruct an amount only with the exact freeze receipt, unique ordered transfer identities, complete pagination and a ledger reconciling exactly with balances bracketing the same solidified head. Shared-millisecond transfers need proven transaction ordering; negative intermediate balances, duplicate transfers and incomplete evidence are rejected. A provider response timestamp is not proof that indexed history is complete.

A recovered zero additionally requires positive-value pre-freeze activity, nonnegative ordered history and a complete confirmed window excluding every configured destroy family for the affected address. Empty or zero-only histories, matching destroys and missing, stale or malformed windows cannot prove zero.

Circle mirror actions are suppressed only when an emitted event-time zero proves the mirror action. Suppressed rows remain auditable but do not contribute to public events, active records or frozen-value totals. Seize-only BUIDL coverage records destroys without inventing an active blacklist state.

### Coverage and limitations

Coverage advances only through contiguous evidence across every required event family. A bounded scan, incomplete pagination, provider failure or unresolved frontier is not full catch-up. Freshness uses the oldest required deployment's proven full-coverage success; rebuilding a summary or finishing a run cannot renew that observation clock. A deployment that has never succeeded leaves coverage freshness unavailable. Observations from other deployments can still contribute to the summary.

Tron event scans prefer admitted Dwellir JSON-RPC, with TronGrid fallback. The provider change preserves the configured event families and historical event identities. RPC scans retain the 15-minute indexing margin and cannot pass a validated solidified head no older than ten minutes; stale head evidence cannot certify catch-up. Block hashes bind event timestamps, and complete block-log context proves transaction-local identities and execution order. An emitted destroy amount can resolve that event's quantity, while amountless freezes still require the confirmed transfer-replay evidence above.

RLUSD clawbacks lack a dedicated event in the verified ABI and are not event-covered. USDA role-gated burns do not emit the configured destroy event. Binance-Peg USDT on BSC and legacy bridged USDT on Optimism emit no blacklist events and are not scanned; Optimism's separate USDT0 deployment is scanned. Removing a non-emitting scan preserves recorded history.

## Storage Semantics

Event history, the historical freeze ledger and local net-active state are separate views. A release does not erase history or a prior successful ledger observation. A destroy may replace a snapshot with a better emitted seizure/burn amount, without adding destroyed funds to the active frozen total.

### Event History

Historical native amounts retain their evidence source and resolution status. Non-USD event valuation requires an attributed quote for that event; a current quote cannot supply historical USD evidence. The current ingestion and recovery lanes have no such historical quote source, so native amounts can be resolved while event-time USD stays unavailable.

USD aggregates are null when every amount is unpriced. Mixed cohorts show known subtotals labelled partial and retain known/unavailable observation counts. A successfully observed empty cohort has numeric zero with zero observations; an unavailable read is not an empty cohort. Explicit observed zero stays zero. Small native amounts retain sufficient significant digits to avoid displaying a nonzero observation as zero.

### Freeze Ledger

Tracked frozen totals are contract-scoped, last-known successful balance snapshots, not live balance guarantees. Released addresses, destroy snapshots and old successful observations remain in the historical ledger; their age and provider failures remain visible. They do not reactivate released accounts or turn historical destroyed balances into active frozen value.

A failed refresh preserves the last successful amount, including observed zero, and its original successful-observation clock. A failed first read supplies no successful value. For gold, substituting a positive event-native amount requires an actual observed zero balance and explicit substitution provenance; a null provider read cannot trigger it. Fresh coin-specific prices may value current non-USD balances, never historical events.

### Cursor State

Scan progress uses EVM block numbers or Tron millisecond timestamps. A frontier advances only through contiguous complete evidence; partial progress cannot claim current coverage or renew full-coverage freshness.

## Exposure Supply And Display

Reviewed registry membership determines exposure bucket counts independently of available runtime supply. Market-cap totals include only observed current circulating supply. Missing or invalid supply is excluded and counted as unavailable, never added as $0; observed zero remains measured zero.

Complete coverage supports full-cohort shares. Partial coverage qualifies shares and totals as observed-only and names excluded assets; the share card is withheld. With no observed supply, totals and shares are unavailable while reviewed coin counts remain visible. A bucket with no observed member supply has no value or share; the combined exposed share is also unavailable when no exposed member has observed supply, even if non-freezable supply is known.

An empty chart means no valued ledger snapshots, not no recorded events. Missing or failed summary reads remain unavailable. Fresh blacklist evidence cannot renew supply or Safety Score evidence: each source retains its own clock, budget and read outcome. CSV exports describe only the currently loaded server page and keep native units separate from USD-at-event values; unavailable amounts remain empty.

## Blacklist Sync State Semantics

The [coverage rules](#coverage-and-limitations) and [cursor state](#cursor-state) distinguish proven observation from bounded scan progress. Event counts, ledger valuations and exposure classifications retain their own populations and evidence clocks.
