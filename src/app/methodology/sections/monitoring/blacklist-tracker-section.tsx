import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologyPreconditions,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { BLACKLIST_SECTION_CONTENT } from "@/lib/methodology-content";
import { METHODOLOGY_SECTION_ACCENT_CLASSES } from "@shared/lib/classification";
export function BlacklistTrackerMethodologySection() {
  return (
          <MethodologySectionShell
            id={BLACKLIST_SECTION_CONTENT.id}
            title={BLACKLIST_SECTION_CONTENT.title}
            versionBadge={{ label: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL }}
            changelogPath={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when classification ownership, tracked contracts, event parsing rules, cursor semantics, or amount-enrichment logic change."
            changelogClassName={METHODOLOGY_SECTION_ACCENT_CLASSES.blacklist.changelogHover}
          >
              <p>
                The Blacklist Tracker monitors issuer intervention events across USDC, USDT, PAXG, XAUT, PYUSD, USD1,
                USDG, RLUSD, U, USDtb, A7A5, FDUSD, BRZ, AUSD, EURI, USDQ, USDO, USDX, AID, TGBP,
                EURC, BUIDL, USDP, TUSD, NUSD, EURCV, USDA, USAT, XUSD, XAUm, JPYC, FRXUSD, and
                FIDD contracts, including blacklist, unblacklist, block/unblock, account pause/unpause, and
                destroy/wipe actions across supported EVM and Tron networks.
              </p>
              <p>
                Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety
                policies, event-time amount attribution rules, and the separate freeze-ledger snapshot used for the public
                summary and quarterly chart, including the reconciled `kyc.rip` / `stables.rip` bootstrap for ETH USDC,
                ETH USDT, and TRON USDT. Current non-USD or commodity snapshot valuations use coin-specific quotes;
                historical event-time USD valuation requires a quote attributed to the event, never today&apos;s price.
              </p>
              <p>
                Historical quantities require evidence at the event&apos;s execution position. Amountless EVM freezes
                and releases use every affected-account transfer in the event block, reconciled exactly against
                balances before and after the block, then replay transfers before the target log. Ambiguous positions,
                negative intermediate balances or failed reconciliation leave the amount unavailable. Recovered zero
                is measured zero, but EURC mirror suppression still requires emitted event-time zero. Previously
                unproved EVM freeze and release amounts receive bounded re-review; suppressed history stays
                untouched. Emitted destroy amounts retain their unambiguous receipt proof, and current-balance
                snapshots remain independent.
              </p>
              <p>
                Public frozen totals are last-known successful freeze-ledger snapshots rather than live balance guarantees.
                Provider refresh failures preserve the previous successful value and surface data-quality context. New
                snapshot identities are contract/config scoped, while older rows can use legacy symbol/chain/address
                fallback until remediation catches them up.
              </p>
              <p>
                Canonical EVM log and Tron account identities count once across events, active state and snapshots.
                Tron storage uses validated lowercase byte addresses, with Base58 reserved for provider calls and
                display. Unknown USD amounts remain unavailable; mixed totals disclose partial valuation coverage,
                and all canonical tracked gold cohorts, including XAUM, contribute when observed. Explicit gold
                zero-substitution provenance remains distinct from an observation failure.
              </p>
              <p>
                Bounded cursor progress is not caught-up chain coverage: an incomplete scan cannot renew success
                clocks or publish a fresh summary. Budget-skipped and order-withheld snapshots are retried from
                durable maintenance debt. Lifecycle and amount ordering require numeric local positions and proven
                cross-transaction order; RPC event timestamps require matching block hashes. A wholly unobserved freeze-exposed population is unavailable, never $0.
              </p>
              <p>
                Blacklistability uses the report-card four-status model: Yes, Upstream, Possible, and No. The sourced
                `blacklistabilityReview.reviewedStatus` is the sole status authority; the generated client status is a
                direct projection, while Safety Score V10 consumes the review as evidence rather than a fallback verdict.
              </p>
              <p>
                Reviews measure each deployment against the Safety Score material-supply threshold (currently 10%),
                never adding sub-threshold deployments together. Missing shares are measured before an unresolved
                deployment is treated as material. Yes requires a current holder-targeted power: blacklist, freeze,
                seizure, forced transfer, enforced transfer allowlist or sanctions oracle, active holder-targeted exit
                gate, or a current role member able to burn arbitrary holders&apos; balances. An admin able to assign
                denylist state directly to a victim already has an active blacklist power.
              </p>
              <p>
                Without Yes, Possible covers global transfer pauses, any admin- or DAO-upgradeable token implementation
                regardless of delay, grantable empty/incapable operator roles, dormant configurable transfer/exit gates,
                material canonical-bridge burner surfaces and issuer-shipped consensus halts. A vault/share&apos;s own
                globally pausable redemption or withdrawal is Possible too. Deposit-only gates, permanently abdicated
                setters, protocol-global redemption or peripheral PSM/swap switches, mint-only authority and
                increase-only rebases are not holder-facing controls.
              </p>
              <p>
                Upstream applies only without direct Yes or Possible: a holder claim on an exposed declared parent,
                full CEX reserve custody, or strictly more than half of measured external backing terminating in issuer or
                custodian control. Qualifying collateral counts categorically at its full share; DAO-only collateral
                controls do not count. Custodial fiat, bank/fund/T-bill claims and allocated physical commodities count.
                CDP/lending books use debt-weighted exposure; reserve-backed tokens use published composition.
                Split LPs by constituent value; exclude the coin and its own wrappers/savings shares from both numerator
                and denominator because they are not external backing. Different tokens from the same issuer count at
                their own status. Unmeasurable reserves never establish Upstream. No means none of these tests establishes
                exposure, not proof that unresolved reserves are free of risk.
              </p>
              <p>
                Reviews name deployments, measured shares, current authorities and reachable controls, pin decisive
                on-chain reads, and cite the parent or measured reserve basis and denominator. Upstream and Possible
                describe exposure, not an asserted active blacklist on this token. See the{" "}
                <a href="https://github.com/TokenBrice/pharos-watch/blob/main/docs/blacklist-tracker.md#freezewatch-decision-procedure" className="text-foreground underline">
                  full FreezeWatch decision procedure
                </a>.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Data sources", value: "Etherscan v2, chain RPC / dRPC log scans, and TronGrid" },
                  { label: "Tracked events", value: "Freeze, Unfreeze, Wipe (AddedBlackList, RemovedBlackList, DestroyedBlackFunds)" },
                  { label: "Chains", value: "Ethereum, Tron, + supported EVM L2s" },
                  { label: "Update frequency", value: "Every 6 hours (`3 */6 * * *`) + backlog reconciliation" },
                ]}
              />
              <MethodologyPreconditions
                variant="compact"
                facts={[
                  { label: "Minimum data", value: "At least one indexed block range per chain" },
                  { label: "Required sources", value: "Block explorer event logs with valid ABI decoding" },
                  { label: "Failure behavior", value: "Preserves last-known snapshots; stale/provider-failed status shown" },
                ]}
              />
              <WorkedExample summary="Worked example: blacklist event reconciliation">
                <p className="pharos-numeric">Event: AddedBlackList(0xabc...def) on USDT (Ethereum), block 19,234,567</p>
                <p className="pharos-numeric">Ledger update: +1 frozen address, total frozen balance recalculated from on-chain balanceOf</p>
                <p className="pharos-numeric">Cross-chain: Tron USDT freeze count unchanged → combined freeze count increments by 1</p>
                <p>Result: <span className="text-foreground">Dashboard shows updated freeze count and reconciled total across chains.</span></p>
              </WorkedExample>
              <MethodologyDetails summary="Technical details: freeze ledger reconciliation">
                <div className="space-y-3">
                  <p>The blacklist tracker stores event-time rows separately from a persistent freeze-ledger snapshot. Each cron run processes new events since the last indexed block; new blacklist rows refresh last-known snapshots, while later unblacklist events do not delete historical ledger rows.</p>
                  <p>Backlog sync handles gaps from missed cron runs or RPC failures by replaying events from the last confirmed cursor. Tron events use a separate ingestion path due to the TRC-20 event format differences, and missing Tron account/token-balance data remains provider-missing rather than being converted to zero.</p>
                  <p>State transitions use timestamp, block number, numeric EVM block-global log index, and batch-array position, never transaction-hash order. Tron events from different transactions in the same block use confirmed within-block transaction positions when observed from chain data; transaction-local indices alone cannot prove that order. Missing or contradictory positions keep state explicitly ambiguous and excluded from confirmed active counts. A bounded maintenance pass resolves both historical and new conflicts without rewinding scan cursors. Malformed required direction, address, array, or identity evidence holds the scan frontier for two observations; the third distinct scan durably quarantines the raw evidence and reason before continuing. Valid empty address arrays do not hold the frontier.</p>
                  <p>The public-facing freeze totals combine per-chain counts into a single figure. Destroy/seize events can overwrite the stored amount when they provide better seized-value evidence, and the public summary reads the persistent ledger rather than treating unfreeze rows as historical deletion. The legacy active fields remain available for the local net-active state machine, but public freeze exposure should use the tracked ledger fields.</p>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
