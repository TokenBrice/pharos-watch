<a id="mint-authority-score-retired-lane"></a>

# Mint Control — Live Safety Score Contract and Retired Lane

This document owns the **live Safety Score economic-authority contract**: native-issuance
scope, the single authority ladder, execution/controller proof, and evidence gates.
Mint risk is graded once by the Economic Control pillar; [Report cards](./report-cards.md)
owns the overall Safety Score model and publication contract.

Only the **standalone Mint Authority Score** retired at safety methodology `9.1`
(2026-08-08). Its [historical landing sections](#methodology-versioning) retain the
terminal version marker and interpretation anchors. The public
`/methodology/#mint-authority-score` surface remains unchanged.

> **Agent navigation** — [Live contract entry](#mint-authority-entry) · [Native issuance scope](#current-v9-scope) · [Authority ladder](#mint-posture-derivation-and-quality-ladder-932) · [Voting proof](#uniform-voting-control-1005) · [Execution classes](#execution-classes-typed-roots-and-diagnostics-1005) · [Retired standalone history](#methodology-versioning) · [Maintenance](#maintenance-checklist). D33/D29/D30/H numeric scoring and seasoning are retired in v10.29; their landing anchors below are not alternative live scorers.

## Mint authority entry

For current mint scoring and evidence, start at [Current V9 scope](#current-v9-scope) (the implementation retains its V9 names in Safety Score V10), then read the applicable posture or process gates here. [Mint Authority Taxonomy](./classification.md#mint-authority-taxonomy) owns taxonomy meaning; `shared/lib/classification.ts` owns display labels. The [native issuance / Bridge Risk authoring boundary](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership) owns schema and registry validation. [Report cards](./report-cards.md) owns overall aggregation and publication, not a second mint ladder.

`V9MintPosture` and curated `MintAuthorityPosture` are descriptive vocabularies, not policy score lookups. The mint-scoped `none-resolved-mint` annotation does not establish absence of upgrade/accountant/allocator powers. `control.authorityLadder` alone owns authority quality; C/U missing factors use `unknownQuality`.

The sections from [Methodology Versioning](#methodology-versioning) through the historical formula, caps, and bands describe the retired lane only. Read them for historical interpretation, not live score changes.

The advisory Mint Authority audit's default Markdown renders every queue, including open questions, source-free rationales, unknown upgrades and reused controllers. Audit counts, live probes and detail evidence links share the typed profile source collector, including no-local-issuance exceptions, upgrade reviews, incidents, controls and custody attestations; counts preserve occurrences while links/probes deduplicate URLs.

### Retired signal migration

Where retained evidence belongs after v10.29 simplification:

| Retained fact | Current role |
| --- | --- |
| Resolved control incident | `control.resolvedIncidentHistory`, only without duplicate whole-score holder-loss charging |
| MPC/HSM key custody | Exact-controller technical evidence, not a second numeric fallback |
| Multisig / weighted signatures / delay | Independent topology facts under `control.authorityLadder` |
| Modules, guards and execution alternatives | Reach and bypass proof; no merged presence penalty |
| Native route family | Descriptive scope, not another quality ladder |
| Bridge capabilities | Representation/deployment-scoped Economic Control |
| `authorityPosture` | Descriptive validated annotation; no numeric score lookup |

DDR's published-posture consumer and curated unavailable-publication fallback remain distinct from Safety Score grading. Mint-scoped absence does not waive economically effective upgrade, accountant, allocator or parameter powers: those always compete in the same ladder. Unknown direct mint ability is never proof of absence.

## Current V9 scope

The live mint component assesses native issuance on canonical deployments and controls that can expand, relax or replace it. Bridge Risk separately assesses representations and cross-chain machinery: bridge mint/burn, adapters, lockboxes/escrow, messaging, limits, upgrades and administrators. One controller may appear in both domains for different powers; bridge capability never compiles as global Mint Authority risk.

Mint controls and mutable mint-logic upgrade paths on active multi-deployment assets bind to reviewed native deployments. Structured bridge controls compile once per referenced route; absent structured evidence retains conservative route-derived controls. [Classification](./classification.md#mint-authority-taxonomy) owns the taxonomy boundary; [catalog authoring](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership) owns schema enforcement.

A controller shared across an issuer's own products is diagnostic only after the exact issuer join succeeds for every member. Full normalized legal/display phrases remain distinct unless a named, primary-evidence-reviewed equivalence joins them; sharing a leading word never removes mint/upgrade common-mode risk. The [issuer-identity contract](./process/report-cards-appendix.md#scoped-evidence-and-exit-evaluation) owns aliases, inheritance and fail-closed group review. This identity join does not improve the controller's own posture, custody or execution evidence.

Curated route badges and compact list/filter status use the same runtime-neutral `resolveMintAuthorityStatusKind` in `shared/lib/classification/mint-authority.ts`. An unknown path remains Unknown even with reviewed controls or verified confidence; this taxonomy correction does not change the published mint component, posture band, or numeric Safety methodology.

Published issuance diagnostics distinguish known adverse facts from missing proof: `active-incident` renders **Failed gate / Active incident**, not Missing evidence. Reader reason labels and statuses share `src/lib/mint-issuance-diagnostics.ts`; scoring and the published reason code are unchanged.

FUSD's exSat deployment is reviewed native issuance, with the same issuer EOA and immediate ProxyAdmin failure domains as its EVM siblings. Its gateway's fresh-message-ID minter can issue without authenticated bridge proof, while the runtime-matched TokenBridgeSender currently only burns/transfers supplied tokens and remains Bridge Risk machinery with a separate upgrade contingency. The exSat contract pauser's signing topology is unresolved; neither a new deployment nor runtime correspondence establishes independent signers, complete execution scope, or incident absence. The separately retained Solana FUSD/FUSDLP liability-identity conflict stays unknown.

Native bank denominations on dual-rail chains are explicit deployments, not synthetic EVM contracts. USDX's canonical `kava:usdx` deployment binds x/cdp minter, collateral/debt-cap parameter controls and validator-adopted software-upgrade paths; its Osmosis ICS-20 voucher remains Bridge Risk. A native-denom identity removes the obsolete external-only-representation exception, not the obligation to research every issuance control. Cosmos committee proposal duration is a voting window, not proof of a minimum execution delay, and a raised collateral-funded debt ceiling is not an unconditional raw-mint permission.

Same-chain HyperCore/HyperEVM spot transport uses the reviewed `sameChainSystemTransport` / `hypercore-evm-spot` family on route controls, not a native minter or external `validator-quorum`. [Hyperliquid's specification](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers.md) assigns the index-derived system address ERC20 escrow transfers and Core credits from Transfer logs; the spot deployer requests linkage and the EVM deployer or storage-bound finalizer confirms it. Exact index/token/contract/controller bindings, dated sources and an observed block are required. `chain-consensus` is known L1 authority without independent-signing or favorable control-quality credit; the family cannot carry an invented quorum, arbitrary mint capability or Safe/MPC claim. The representation ownership check admits this schema-validated escrow family without inventing an ERC20 mint holder, while all other structured representations still require `bridge-mint`. FEUSD index 241 uses `0x20000000000000000000000000000000000000f1`; Felix's eight ERC20 minters and upgrade Safe remain separately assessed.

Every admitted economically effective mint, upgrade, fee/accountant, allocator, curator, custody-transfer or parameter-change path competes in the same weakest-path ladder, regardless of capability label. Deployment-local effects retain admitted proportional exposure; root/global paths bind the whole claim. Access-only freezes with `claimImpairment: none` are disclosure-only. A deposit gate does not bound an accountant, and an immutable proxy does not prove immutable economic logic. An incomplete aggregate review cannot erase independently established reach or topology.

The separate unresolved-deployment-share post-evaluation Control adjustment is removed in v10.29. Genuinely unknown authority, oracle and bridge factors still use C50/U60 at their own component scope, and admitted deployment-local failures retain measured reconciled-share pricing without inventing a zero share. Known weak oracle/bridge quality 45 and compromised authority 25 remain measured, not replaced by unknown values.

### V10 exact execution scope and weighted signing

An optional `executionScope` certificate on a native or bridge control binds the exact chain-qualified controller, deployments/entrypoints, actual capabilities/economics, liabilities, activation, review/observation/expiry dates, independent reviewer and sources. `pin` and `observedState` bind runtime/build and signers; changes invalidate it. Complete inventory requires every closure flag: entrypoints, mutable targets, delegate/fallback execution, permissions, upgrades, bypasses and liabilities. Partial, future, expired or mismatched reviews retain the unresolved remainder and cannot exclude another authority on the deployment.

Methodology v10.08 admits a `downstreamCallDomain` with `kind: "conservative-maximal"` only when verified source and pinned runtime positively prove arbitrary downstream CALL targets and bytes at the exact executor, bound to its exact controller. The executor remains the concrete `targetDeployment`/selector ingress; `sourceDeployment` identifies its executable source (including an EIP-7702 implementation), with matching observed runtime identity and the same block/hash and authority identity. This is a complete **adverse upper envelope**, not an assertion that targets, signed permission contexts or future role grants have been enumerated. Every capability in the control vocabulary is retained conservatively, including mint/burn, upgrade, freeze/pause, seizure, oracle, bridge, custody and parameter/role-admin changes across the asset inventory; reach is root/global, cap and claim impairment unbounded, loss scope global-claim, and delay is the executor's minimum enforced delay (zero without one). No capability exclusions, local sizing, benign-target or extension-noninterference credit are admitted. Exact paths may coexist but cannot soften this envelope. Partial inventory remains partial, and missing or changed executor/source proof cannot complete scope; signer custody, incident and unrelated authority questions remain independent.

Partial execution inventories publish diagnostics and preserve admitted facts; no aggregate `reviewComplete`, posture or immutable enum may switch an entire compound score proof. Complete current closure is needed to narrow capabilities or exclude another path. Canonical control keys retain authored permission identity, label and deployment references, so two permissions held by one controller cannot collapse. Native/representation reclassification still requires an admitted reviewed economic-supply plan.

A fresh controller-scoped semantic question retains its exact unresolved reach and evidence without converting it to global impairment. Verified sibling facts survive. Independently established root/global economic reach cannot be softened by adding an unknown path; potential unbounded power is not itself a realized incident. Custody-only questions do not deny independently proved economic topology or establish human independence. Missing one datum removes only its corresponding credit.

`active`, `counterfactual` and `disabled-reactivatable` paths remain reachable. A counterfactual Safe needs its same-chain factory/build, CREATE2 address/salt, fixed full initialization, owners/threshold/modules/handler and account-state pin; no runtime code does not mean EOA or renunciation. Only execution-complete `disabled-final` proof removes that specific issuance action. Re-enable, grant and upgrade paths, outstanding receipt liabilities, freeze/exit powers and other failure domains remain. CCIP shutdown never means ordinary ERC20 transfers are prohibited. Chain-local execution does not bound root issuance economically: local sizing still requires the independently admitted complete liability partition.

A `disabled-final` label in partial execution evidence cannot remove established issuance economics: positively known liability reach and adverse semantics persist until current execution-complete closure proves that action removed. Unknown activation or reach cannot establish adverse promotion.

Safe modules/guards/fallback handlers remain execution inventory and reach evidence, not separate merged-score bonuses or presence penalties. Current exact-path proof must establish whether an extension changes effective authority or bypasses a bound/delay; unknown reach grants no favorable closure, and purpose labels alone prove no exclusion.

A Safe-wide timelock may live in `safe.guard` without changing the token's owner or governor address. Record the actual Safe controller, `timelockDelaySec` and its pinned extension state; verify scheduling, execution, cancellation, self-reconfiguration, modules and fallback paths. Use the guard's actual delay getter and authorization rules, not invented `getMinDelay()` or proposer/executor/canceller roles from a different timelock design. A governor-only read cannot establish the absence of an execution delay.

`weightedQuorum` is mutually exclusive with uniform `threshold`/`signerCount`; retain unique positive weights, attainable quorum, exact authority/deployment identity and original dated evidence. The compiler derives the minimum executable signature requirement. XRPL master-key/RegularKey alternatives remain part of that minimum: a live unilateral alternative defeats quorum credit, and unknown alternatives cannot grant it. No signature-count bonus ladder or human-independence inference survives; use the same authority topology ladder.

Fresh verified weighted evidence bound to the exact authority is known signing topology despite an absent uniform threshold; the control compiler uses the effective minimum-signature requirement rather than treating that mutually exclusive threshold as missing. Expired, over-age, future or unverified weighted reviews remain unknown, as do unobserved XRPL key alternatives. Different chain-qualified EVM authorities retain separate scopes.

Native XRPL issued-currency contracts use `amountEncoding: {kind: "xrpl-issued-currency"}` and `decimals: null`. Issuer/currency plus the quoted decimal value normalize losslessly to a signed 16-digit coefficient and exponent under `semantic.control.exactScope.issuedCurrencyAmount`; zero is canonical, overprecision/out-of-range values are rejected without rounding. Fixed raw-integer readers do not scale this branch or substitute 6/18 decimals. This introduces no XRPL supply source, supply override or automatic favorable curation.

### Reviewed absence is a fact, not a gap (`9.24`)

Reviewed absence is a positively established fact, not a default inferred from missing evidence:

- **No bridge.** An inventory whose every reviewed route is native issuance and has no separately declared external-validation rail is not bridge-exposed, even where structured controls govern those canonical deployments — such a control administers the canonical liability, not a representation. It scores `single-chain-or-native` rather than the `opaque-or-unknown` fallback. A reviewed representation route keeps Bridge Risk applicable even when no control compiled for it, and an unresolved zero-share deployment stays an audit fact rather than proof of no bridge. An explicit `bridgeRouteRisk.nativeExternalTransferReviews[]` declaration keeps Bridge Risk applicable: current exact evidence can establish its external-validation tier, but unknown rail controls remain bounded without duplicating native mint authority; stale/future declarations never prove absence.
- **Incomplete bridge materiality.** A bounded review retains reviewed route rows when its measured unattributed share is below `unresolvedDeploymentFullCeilingSharePct` (15%), not the individual deployment materiality threshold. A missing or unresolved review, or a bounded review with an unavailable/material residual, remains fail-closed. In the admitted branch, incomplete subthreshold joins still emit `runtime-bridge-materiality-unavailable`; each route's control is checked independently.
- **No local issuance.** A reviewed `mintAuthority.review.noLocalIssuance` exception scores the mint component `none-resolved` only when the displaced risk is carried elsewhere: an `inherited-parent-issuance` claim must compile a serial-claim dependency edge to its named parent, and an `external-only-representation` must carry the reviewed route inventory that already has to cover every authored deployment. Any authored control keeps the mint review in force so no reviewed upgrade authority is dropped from the grade. Absence is never inferred.

An inherited claim is curated as a wrapper reserve slice naming the parent, not as a copy of the parent's collateral composition; the copy both double-counts the parent's exposure and leaves no edge for the parent's mint risk to travel along.

For an inherited share wrapper, the deposit-backed accounting control can anchor the local mint component only when its reviewed row explicitly records `role: "wrapper"`, `directMintAbility: "none"`, and `canRaiseCap: false`, and the exact serial-claim edge exists. Omission of `canRaiseCap` is not proof of absence; separate upgrade and parameter authorities keep their own controls and uncertainty.

### A reviewer-scoped open question is limited evidence (`9.27`)

`mintAuthority.review.scopedQuestions` binds an investigated unresolved question to the exact controller, question, reviewer, sources and original review date. Its research freshness and scoped causes remain evidence, not a second 69/55 whole-score ceiling or a process-rung switch. Missing one factor uses C/U only for that factor; no open question by itself withholds a rating. Global/local scope still requires a complete reconciled liability partition, never an invented zero share.

A fresh semantic scoped question blocks known-semantics and nonbinding/access-only shortcuts: its control stays required and `bounded-unknown`, with its scoped gap retained even if its other fields are known. Optional `subject` values are `authority-semantics`, `execution-scope` and `key-custody-independence`; omission gates conservatively without parsing prose. A typed custody/independence-only question publishes its own factor gap without gating established authority/economic semantics or establishing human independence. Admitted exact-controller MPC/HSM technical custody remains available only while the control's own admitting review is complete and current; incomplete or expired reviews withhold it, and a parent review cannot renew it. Mixed questions on one controller remain semantic unless every fresh matching question is custody-only. Current complete execution closure or positively proved adverse root reach in a current partial scope retains existing proof precedence; expired, mismatched and unknown-reach scopes do not.

Structured bridge questions use `bridgeRouteRisk.scopedQuestions`, naming a control by ID, exact label or `controllerChain:controllerAddress`. A route-level merge softens only if every unresolved contributor has a fresh matching question. Unreviewed route-derived fallback controls never qualify.

Reviewed absence of discretionary economic power earns the immutable-no-power 90 only with independently proved economic reach and immutable execution. A `none-resolved` label or `claimImpairment: none` alone is insufficient. Oracle and bridge applicability remain separate.

Unknown oracle/bridge factors use Control C50/U60 without fabricated measured adversity or structural caps. Known weak single-source/manual/internal pricing retains measured quality 45 where applicable. Coverage reasons retain source identity and responsibility; no whole-score oracle 55/59 ceiling remains.

Safety Score `10.10` admits independent researched-negative reviews from `incident-reviews-v1.json.negativeReviews` without unrelated aggregate closure. A current sourced review matches an exact compiled mint/bridge control key or exact deployment/control kind, resolving only `incidentState: "unknown"` to `"none"`. Global controls never match deployment scope; actual same-kind active/resolved incidents take precedence. Issuer notices, exact-deployment events and independent incident research retain excerpts, original clocks, reviewer and an honest finite search window; audits/empty registries prove no absence. Review and window end age under the reviewed-research budget. Date-only incident reviews admit from **00:00Z on their review date**, unlike next-day mechanism overlays. Aggregate `reviewComplete` absence keeps its path; authority, custody, reach and scoped gaps remain independent.

### Mint posture derivation and quality ladder (`9.32`)

In v10.29 descriptive posture is derived from reviewed facts, never used as a numeric lookup. **Scope first, topology second:** traverse the execution/controller graph and take the weakest admitted effective economic path, including upgrades, accountants, fees, allocators and curators. Contract addresses are not quorum proof. Negative incident clearance is not topology proof.

| Effective authority topology | Base quality |
| --- | ---: |
| Verified single EOA / one-signature path | 50 |
| Opaque/incompletely resolved controller | 60 |
| Verified multisig or affirmative governance without unavoidable delay | 65 |
| Verified multisig plus unavoidable timelock | 70 |
| Public governance/minority veto plus unavoidable timelock | 75 |
| Reviewed no discretionary economic power and immutable execution | 90 |

Add 10 only for an enforceable economic bound preserved by **all** relevant bypass, permission, reactivation and upgrade paths. An instant-raiseable nominal ceiling is unbounded; an unknown bound earns no credit. A bound on one leaf cannot conceal an unbounded root.

Add at most 15 for continuous/periodic external reserve-to-liability reconciliation, and 15 for prudential supervision **or** 10 for attestation-only supervision, never both. Maximum assurance credit is 30; each independently curated datum adds at most 15. Clamp once after topology, bound and assurance at `control.authorityLadder.maxComponentQuality` **90**, the immutable-no-power level (AM7). `none`, `unknown`, `not-applicable` and unsupported internal-ledger assertions earn zero assurance. A reserve NAV feed does not establish authorization or an enforceable mint bound; legal supervision is not immunity.

The overall Economic Control pillar is also clamped at **90**, including non-authority-only components; their raw diagnostics remain visible. Scores above 80 do not require supervision when independently evidenced topology, bounds and assurance earn them.

For a genuinely missing factor use the sole `unknownQuality(pillar,cause)` helper: Control C50 for researched issuer non-disclosure, U60 for Pharos research/infrastructure uncertainty or unclassified gaps. Preserve measured known components. Opaque potential authority is not exploitation. An admitted active economic control incident, compromised/exploited authority or source-proved realized unbacked mint stays **25**, with no bound/assurance uplift.

Verified worse facts score lower than unresolved ones: proving that an opaque controller is a single key lowers its base **60→50**. Unknown is priced as uncertainty, not as safety; resolving evidence can lower a score.

Resolved authority failures use an initial component limit **55** through elapsed day **365**, then relax linearly to **100** at day **730**: `min(100, 55 + 45 × max(0, ageDays − 365) / 365)`. Use the original incident date and exact elapsed days, not month tiers; an unknown incident date retains 55. Active incidents never decay. The former permanent 70/85 history tiers are removed; retain only distinct authority-failure treatment without duplicating a whole-score holder-loss charge.

Treasury, credit-fund and UCITS/TRS-fund claims require top-level NAV/pricing review. Missing or stale review prices U60 rather than dropping the oracle; sourced privileged/single-source pricing remains 45 and sourced external relay quality remains measured. A current applicable savings-rate review routes the setter to the existing authority inventory/ladder once, not a separate internal-pricing oracle penalty. Missing setter proof is U60. Only compiled governance, unavoidable delay and all-bypass closure can earn a higher topology rung; no issuer/DAO family name supplies those facts.

No aggregate posture, review-complete or immutable label may select the whole compound proof: quorum, delay, bound, reconciliation and supervision need independent admission. A missing fact removes only its own credit. Authority quality is the minimum of applicable economic paths, retaining scoped deployment allocation; the separate numeric role-dependency limits are removed.

#### Availability-invariant mint fallback (`10.06`)

**Retired in v10.29:** D33's reconciliation/process matrix, separate verified-authority fallback, merged quorum/module/custody rungs and 60-month seasoning credit are deleted. The single ladder above applies whether the wider review is complete or partial. Unknown reconciliation remains an attributed missing factor, never an adverse incident or a 25-point potential-power rung.

Retain nonempty exact `causeGapIds` and resolving public `causeGapRefs` for included C/U contributions, canonical ordering and asset-local failure for malformed required references. Do not invent, borrow or silently clear scoped gaps. Aggregate mint/reconciliation questions retain their own origins even when a deployment question closes. Internal-ledger workflow remains distinct from independent whole-liability reserve assurance.

### Governed unbounded issuance (`10.02`)

**D29 numeric scoring retired in v10.29.** Governance, execution inventory, typed rooting and voting evidence remain inputs to the one ladder; no process-specific base, cap, seasoning or precedence remains. Every effective upgrade path competes with mint paths. A delay protects only paths that cannot bypass it; every relevant controller/root and permission alternative must be traced.

Economic cap semantics remain factual authoring: source-proved collateral/deposit-only construction can establish a bound only when all economically effective bypass and upgrade paths preserve it. Arbitrary chosen-recipient unbacked issuance is unbounded; missing construction proof is unknown. Keep sourced `capSemanticsReview` under the [registry contract](./stablecoin-data.md#governed-issuance-and-cap-semantics-review), rather than inferring a favorable value from current stock or a numeric adjustable ceiling. Parent issuance is inherited through serial dependency, not copied as a second local authority charge; wrapper-local fee/accountant/reallocation power still competes.

### Minority-veto issuance (`10.03`)

**D30 numeric scoring retired in v10.29.** Admitted minority-veto and unavoidable public-delay evidence can support the same governance/timelock rung as equivalent facts elsewhere; no separate veto score or cap survives. Admission windows do not establish already-admitted minters' exercise delay. Review actual reachable exercise, override, restructure and reactivation paths; keep exact units, pins, voting provenance and source witnesses. Permissionless self-collateralized borrowing and atomic repaid flash minting do not imply discretionary unbacked issuance; separate interest/loss-coverage powers retain their own economic scope.

### Operationally governed issuance (`10.05`)

**H's numeric scorer retired in v10.29.** Authored operational-flow and governance certificates remain factual diagnostics, not a second screened 55/59 rung or structural cap. Formula/keeper/interest paths are assessed for actual holder-claim power in the same authority ladder. Missing process proof cannot nullify independently proved topology/bounds, and a favorable process label cannot hide a faster reachable economic path.

### Uniform voting control (`10.05`)

**D32 voting provenance remains evidence for the single authority ladder, not a D29/D30/H score gate.** Use source-enforced actual approval thresholds, quorum/decay and delegation alternatives, exact arbitrary-precision powers and a proved disjoint residual. Positively identified issuer/team/council affiliates aggregate; neither split common control nor merged unrelated holders establishes independence. A possibly decisive unresolved residual cannot establish favorable governance topology.

For any controller that can pass the governance route alone:

1. Voting its **OWN locked/escrowed governance tokens** is admissible token governance, unless **positively identified issuer/team/council-affiliated**. A Safe owning its own lock is not automatically a council. Concentration and unknown beneficial affiliation are published diagnostics, not an identification requirement or a denial.
2. A key (EOA, Safe, multisig or operator) casting **OTHER holders' votes**, or able to replace their caster without on-chain token-holder approval, is council control. A threshold-capable key with actual other-holder casting/replacement authority fails even if its own stake alone suffices, regardless of an independent affiliation label. If passing alone requires those other-holder votes, deny as well. Revocable delegation is not forced delegation, but a unilateral other-holder key/operator still fails.
3. Nongovernance **privileged or forced vote creation/delegation** denies.

Controllers that cannot pass alone need no identification. Minority-veto power is not affirmative expansion approval: a 200-bps veto holder does not automatically become a unilateral expansion controller. Review separately any route that removes/bypasses the veto, overrides admission or restructures voting equity.

Historical voting evidence remains useful after D29 scoring retires: Ethereum block 26118754 placed Convex VoterProxy at approximately 54.1% of pinned veCRV, with its pooled other-holder vote caster replaceable by the extension's 3-of-5 Safe. The [verified extension source](https://eth.blockscout.com/api/v2/smart-contracts/0x5349ffba494ac3c888ffa16fd438f44b8c67fb07) supports operator/replacement reach, not a concentration-only cap or an accusation about holders. Proved own-locked stake and minority veto are different facts. Actual current admitted topology and engine replay determine scores; historical process disqualification is not a permanent numeric assignment.

### Execution classes, typed roots and diagnostics (`10.05`)

Class-level certificates compress repeated contract-type proofs without reducing evidence strength. `executionCertificates` binds the full authoritative census, reusable source/runtime invariants and exact deployed members; every member has its own runtime/proxy/implementation, immutable/storage conditions, activation, liability and path bindings. Individual scopes remain valid alternatives. Constructor assignments, full authorization history/getters and latent/stopped members must reconcile exactly; a sample is not a census. Only proved compiler metadata/immutable offsets may normalize bytecode, with each required immutable value separately observed. Unmatched members block global process credit but never erase known adverse paths.

Each compact class member must match its own observed runtime hash; an exemplar or original address never admits a member by itself. EIP-1167 minimal-proxy clones of one implementation share byte-identical 45-byte runtime, so a class may declare `cloneRuntimeVariants` (exact clone runtime hash, `proxyKind: "eip1167"`, the referenced implementation identity and a source-proved match proof). A clone admits only when its observed hash equals that variant and the referenced implementation independently matches its reviewed source/runtime; behavior comes from the implementation's class. ZCHF's 188 Position clones bind through 24 such variants.

`authorityGraph` replaces signer-prose rooting with dependent → enabling-authority/origin edges, explicit path bindings and authority-state fingerprints. Traverse every alternative permission, upgrade, execution, reactivation and vote-caster/replacement route; keep economic origin/recipient/claim provenance distinct. No address substring, DAO name or closed-cycle assumption grants rooting. D32 establishes voting provenance before a genuine token decision root closes authority traversal.

Compiled governance/process facts retain one asset-level `issuanceFacts` object referenced by native rows. `breakdowns.control.issuanceSummary` remains compact evidence/diagnostics, with grouped counts and exact control references, not repeated full objects or a second H scorer. Authored execution/controller proof stays source-bound even though process-specific numeric qualification is retired.

Each public diagnostic group contains `code`, `gate`, `classId`, `field`, whole-group `count`, the **complete sparse** normalized `controlRefs` set (including null for process-level failures), and at most **three exemplars**. Exemplars retain sampled control/path/member identities, `evidenceRefCount` and at most three evidence refs; they are explicitly sampled and non-exhaustive, never a full path/member census. Group count is not the count for each listed control. Actual versus discretionary/envelope clocks, concentration and terminal-controller failures remain visible in the compact summary, with missing evidence distinguished from proved screen failure.

The UI reads this summary once with `readV9CardIssuanceSummary`, matches controls by the complete normalized `controlRefs` set rather than a sampled exemplar or display index, and keeps null/process-level groups visible. The Mint Authority module's `Issuance diagnostics` fold then groups the published diagnostic groups in plain language (`groupMintIssuanceDiagnostics`, `src/lib/mint-issuance-diagnostics.ts`): one row per status and reason, with the finding count, the affected fields merged by humanized label, the rendered controls they touch, a process-level marker and counts of execution classes and cited evidence references. Sampled exemplars and per-group totals are no longer shown, and gate codes, class ids, path ids and evidence ids never reach the page. The browser never recalculates qualification; absent legacy summary fields mean unavailable diagnostics, not favorable proof.

Full inline authored proof inputs remain bound by the existing catalog capture/fingerprint, policy digest and evaluation-build identity; compaction does not weaken admission or add an external runtime registry. Wrappers use existing dependency propagation, not copied native certificates.

### Activation calibration (`10.05`)

The former D/F adverse-witness and evidence-threshold rating guards are retired in v10.29. Calibration and source witnesses remain diagnostic; unavailable supply is never zero. Rating requires usable admitted evidence, not a favorable letter or a process certificate.

### Truthful path corrections and GHO improvement trigger (`10.05`)

O0 corrects path encoding without converting a fixed first hop or a zero-current state into global favorable closure:

- **GHO fixed-pool minters:** `mintAndSupply(uint256)` (`0x749b1e8b`) supplies the immutable configured Core/Lido/Horizon pool, not a caller-selected pool. Downstream pool/admin/withdraw reach is separate; the fixed first hop is not automatically reserve-backed. Historical evidence pin: Ethereum **26118181**; Core `0x5513224daaeabca31af5280727878d52097afa05`, [implementation source](https://eth.blockscout.com/api/v2/smart-contracts/0xe4c958de49303c9be571e00582cf9454586de76f) (53–74); Lido `0x2ce01c87fec1b71a9041c52caed46fc5f4807285`, [implementation source](https://eth.blockscout.com/api/v2/smart-contracts/0xc718786a7e45353835de634897385b3371a749f0) (54–75); Horizon `0xe10c78a3ac7f016ed2de1a89c5479b1039eab9ea`, [implementation source](https://eth.blockscout.com/api/v2/smart-contracts/0x68807d04df1f1bb74bb7498b1e832d2ce356cd18) (53–74), each `mintAndSupply` body. These historical observations are not cosmetically refreshed to the campaign pin.
- **GHO ordinary payload clock:** the corrected integer-second public-visibility lower bound is **345603 seconds = 1 + 259201 + 86401**. The older 432003-second value included pre-payload cooldown. Slot timing/transport may add latency; this is not a claim of exact attainability or complete mutable-target closure. Independent zero-delay Council paths remain independent. Historical Ethereum **26118181**: live Governance `0x9aee0b04504cef83a65ac3f0e838d0593bcb2bc7`, proposal-creation / `activateVoting` source predicates, [implementation source](https://eth.blockscout.com/api/v2/smart-contracts/0x58bcb647c4beff253b4b6996c62f737b783f2cdd) (2879–2990); live PayloadsController `0xdabad81af85554e9ae636395611c58f7ec1aaec5`, `createPayload` / queue / execution predicates, [implementation source](https://eth.blockscout.com/api/v2/smart-contracts/0x7222182cb9c5320587b5148bf03eee107ad64578) (2386–2463, 2565–2617).
- **Sky current versus legacy LockstakeClipper:** distinguish current `0x836f56750517b1528b5078cba4ac4b94fbe4a399` (`stopped=3`, Mom ward 0) from legacy `0xa85621d35caf9cf5c146d2376ce553d7b78a6239` (Mom ward 1). Do not copy the legacy Mom bypass onto the current instance or delete governor-reachable latent capacity. Ethereum block **26118754**, `stopped()` and `wards(address)` (`0xbf353dbb`), the Mom breaker setter (`0x2145a7f3`); [current verified source](https://eth.blockscout.com/api/v2/smart-contracts/0x836f56750517b1528b5078cba4ac4b94fbe4a399) and [legacy verified source](https://eth.blockscout.com/api/v2/smart-contracts/0xa85621d35caf9cf5c146d2376ce553d7b78a6239), ward authorization and breaker source bodies.
- **D3M `_exec` fee/donation accounting:** positive Vow `suck` paired with positive `grab` cancels the added sin/vice and creates matched pool debt. It is paired accounting, **not atomic `heal`**, blanket loss-replacement mint or automatically harmless surplus transfer. The negative loss/cull branch is separate, and zero line/Art does not erase residual assets or latent accounting reach. Ethereum block **26118754**, Hub `0x12f36cdea3a28c35ac8c6cc71d9265c17c74a27f`, `exec(bytes32)` / `_exec` source body; [verified Hub source](https://eth.blockscout.com/api/v2/smart-contracts/0x12f36cdea3a28c35ac8c6cc71d9265c17c74a27f), `_exec` lines 399–429.

The pinned GHO chosen-recipient branch above is an economic-power fact, not a permanent asset-specific mint25 assignment. Under v10.29 its actual effective controller topology, bypasses, bounds and assurance use the same ladder as every asset. These historical pins alone assert no current total, grade or engine-replay result.


### The external validator-quorum authority rung (`9.46`)

`validator-quorum` identifies an external validation domain rather than a key holder: for example DVNs, CCIP DON/RMN, AMTP or IBC validator sets. Curate it only when that domain actually controls the power; a named operator behind it remains that operator.

The retired `gradeVerifiedControlAuthority()` 45-point fallback is no second scorer. A reviewed external validation domain retains its actual executable authority facts under the same economic-authority ladder; unknown factors use C50/U60, measured weak oracle/bridge facts retain 45, and a reachable unilateral key remains the weakest effective path. No external quorum name proves independent humans or favorable custody.

Both native-mint and bridge mappers use the same authored authority mapping: `bridge` → `contract` (like timelock), `custodian` → `issuer-backend`, and `validator-quorum` → its explicit rung. A missing mapper branch must not silently turn a reviewed authority into `unknown`.

The short historical landing below describes only the retired standalone engine. Its headings preserve existing interpretation links; live changes belong to the contract above and the Safety Score changelog.

## Methodology Versioning

- **Current methodology version:** <!-- GENERATED-START: methodology-version-mint-authority -->`v1.3`<!-- GENERATED-END: methodology-version-mint-authority --> (terminal — lane closed)
- **Runtime/version source:** `shared/lib/methodology-versions/mint-authority.ts`
- **Structured changelog:** `shared/data/methodology-changelogs/mint-authority/`
- **Scoring source:** none — the retired engine module was deleted with the lane; the live mint component lives in `shared/lib/safety-score-v9/control.ts`
- **Public methodology anchor:** `/methodology/#mint-authority-score`

## Historical purpose

The standalone score reviewed privileged durable-supply creation and routing. It began as a display/coverage methodology, fed V8 Decentralization through a 35% penalty-only blend from Safety `8.0`, and retired at Safety `9.1`. The [structured Mint Authority changelog](../shared/data/methodology-changelogs/mint-authority/v1.json) owns its release history; later mint changes belong to the Safety Score changelog (`shared/data/methodology-changelogs/safety-score/`).

## Inputs

Historical inputs were curated `mintPath`, `authorityPosture`, `confidence`, `controls[]`, `inheritedFrom`, and `mintIncidents`. Missing/unresolved evidence meant `NR`, never safety. Current metadata is authored in `shared/data/stablecoins/domains/mint-authority/<id>.json`; use the [registry contract](./stablecoin-data.md#mint-authority-and-bridge-risk-ownership), not retired field semantics, for edits.

## Formula

The retired v1.2 formula was `round(route × 0.30 + controller × 0.40 + bounds × 0.15 + posture × 0.15)`. Controller scoring used the weakest mint-capable path (direct mint, minter authorization, cap raise or mint-logic upgrade). The immutable-cap bonus required every cap-limited mint-capable control to explicitly record `canRaiseCap: false`; mutable, unknown or omitted evidence retained only capped-path treatment. This formula is not evaluated by any current surface.

## Caps

Retired post-formula limits were incident 10 / 15 / 20 (most recent incident under 2 / 2–4 / 4+ years; invalid dates stayed 10), unbounded without incident 25, non-issuer-context unattested mint-capable EOA 40, and confidence 100 / 90 / 85 for verified / probable / manual review (unknown meant `NR`). Incident limits stayed below the unbounded limit. These are historical limits, not current Economic Control caps.

## Inheritance

Retired `wrapped-or-variant-inherited` rows used the lower of the parent score and a 60% parent / 40% weakest wrapper-control blend. Missing, unscoreable, cyclic or depth-limited parents returned `NR`. Current inheritance follows the [Safety Score dependency contract](./process/report-cards-appendix.md#dependency-coverage), not this blend.

## Bands

Retired score cutoffs were Hardened 80–100, Governed 65–79, Managed 50–64, Concentrated 35–49 and Exposed 0–34; missing or insufficient review was `NR`. Current bands derive from the [published mint posture](#mint-posture-derivation-and-quality-ladder-932), never these numeric cutoffs.

## Historical Surfaces

Detail pages formerly displayed that standalone score, band, component breakdown and caps. Current homepage/screener/detail mint scores use the published Economic Control mint component; `/coverage/` retains curated route-review breadth. `resolveMintAuthorityStatusKind()` in `shared/lib/classification/mint-authority.ts` labels curated route metadata, not numeric score bins. No current raw `mintAuthorityScore` input survives the retired lane.

## Maintenance Checklist

When adding or updating `mintAuthority` metadata:

1. Verify source links, current controls, thresholds, module/guard status, cap authority, proxy/admin reads, bridge route checks, and unresolved questions. Author the optional `headline` (the detail card's verdict, ≤25 words, no raw identifiers; schema-validated through `shared/lib/summary-budget.ts`) for every new or promoted profile, and keep the reviewer narrative in `summary`.
2. Curate metadata from verified primary sources and pinned native-control reads. Generated unknowns or historical scanner candidates are not evidence.
3. Use the advisory audits for review breadth and ownership: `npm run audit:mint-authority-review` for the curated review backlog (add `-- --live` for the advisory cited-source probe, or `-- --json --report agents/mint-authority-review/audit.json` for saved JSON), and `npm run audit:mint-bridge-ownership` for authored mint/bridge domain ownership. Neither gates a merge; see [Curation Audits](./scripts.md#curation-audits).
4. Regenerate stablecoin projections and run metadata checks.
5. Run focused scoring and surface tests when score-affecting fields change.
6. For live mint scoring or display changes, update this contract, the overall [Report Cards](./report-cards.md) contract where affected, `/methodology`, route docs, and the Safety Score structured changelog when methodology changes. The Mint Authority `v1.3` lane and its historical formulas remain terminal.
