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
export function BlacklistTrackerMethodologySection() {
  return (
          <MethodologySectionShell
            id={BLACKLIST_SECTION_CONTENT.id}
            title={BLACKLIST_SECTION_CONTENT.title}
            versionBadge={{ label: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL }}
            changelogPath={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when classification ownership, tracked contracts, event parsing rules, cursor semantics, or amount-enrichment logic change."
            changelogClassName="hover:text-rose-700 dark:hover:text-rose-400"
          >
              <p>
                The Blacklist Tracker monitors issuer intervention events across USDC, USDT, PAXG, XAUT, PYUSD, USD1,
                USDG, RLUSD, U, USDtb, A7A5, FDUSD, BRZ, AUSD, EURI, USDQ, USDO, USDX, AID, TGBP,
                EURC, BUIDL, USDP, TUSD, NUSD, EURCV, USDA, USAT, AEUR, XUSD, XAUm, JPYC, FRXUSD, and
                FIDD contracts, including blacklist, unblacklist, block/unblock, account pause/unpause, and
                destroy/wipe actions across supported EVM and Tron networks.
              </p>
              <p>
                Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety
                policies, event-time amount attribution rules, and the separate freeze-ledger snapshot used for the public
                summary and quarterly chart, including the reconciled `kyc.rip` / `stables.rip` bootstrap for ETH USDC,
                ETH USDT, and TRON USDT. Non-USD or commodity-denominated assets use coin-specific price-cache entries
                when Pharos reports USD frozen value.
              </p>
              <p>
                Public frozen totals are last-known successful freeze-ledger snapshots rather than live balance guarantees.
                Provider refresh failures preserve the previous successful value and surface data-quality context. New
                snapshot identities are contract/config scoped, while older rows can use legacy symbol/chain/address
                fallback until remediation catches them up.
              </p>
              <p>
                Blacklistability uses the report-card four-status model: Yes, Upstream, Possible, and No. The sourced
                `blacklistabilityReview.reviewedStatus` is the sole status authority; the generated client status is a
                direct projection, while Safety Score V9 consumes the review as evidence rather than a fallback verdict.
                Upstream applies when a token has no direct Yes or Possible holder-facing freeze control and strictly
                more than half of its reserves are exposed to Yes, Upstream, or Possible upstream assets or rails.
                Possible is reserved for curated direct token or vault controls that are not confirmed direct blacklist
                controls.
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
                  <p>The public-facing freeze totals combine per-chain counts into a single figure. Destroy/seize events can overwrite the stored amount when they provide better seized-value evidence, and the public summary reads the persistent ledger rather than treating unfreeze rows as historical deletion. The legacy active fields remain available for the local net-active state machine, but public freeze exposure should use the tracked ledger fields.</p>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
