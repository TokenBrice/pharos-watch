import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export function BlacklistTrackerMethodologySection() {
  return (
          <MethodologySectionShell
            id="blacklist-tracker-methodology"
            title="Blacklist Tracker Methodology"
            versionLabel={BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL}
            changelogPath={BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH}
            versionNote="Version increments when tracked contracts, event parsing rules, cursor semantics, or amount-enrichment logic change."
            accentClassName="border-l-rose-500"
            badgeClassName="border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
            changelogClassName="hover:text-rose-700 dark:text-rose-400"
          >
              <p>
                The Blacklist Tracker monitors issuer intervention events across USDC, USDT, PAXG, XAUT, PYUSD, USD1,
                USDG, RLUSD, U, USDtb, A7A5, FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, TGBP, EURC, and BUIDL contracts, including blacklist, unblacklist, block/unblock, account
                pause/unpause, and destroy/wipe actions across supported EVM and Tron networks.
              </p>
              <p>
                Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety
                policies, event-time amount attribution rules, and the separate freeze-ledger snapshot used for the public
                summary and quarterly chart, including the reconciled `kyc.rip` / `stables.rip` bootstrap for ETH USDC,
                ETH USDT, and TRON USDT. Non-USD or commodity-denominated assets use coin-specific price-cache entries
                when Pharos reports USD frozen value.
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Data sources", value: "Etherscan event logs (EVM) + Tronscan (Tron)" },
                  { label: "Tracked events", value: "Freeze, Unfreeze, Wipe (AddedBlackList, RemovedBlackList, DestroyedBlackFunds)" },
                  { label: "Chains", value: "Ethereum, Tron, + supported EVM L2s" },
                  { label: "Update frequency", value: "30-minute cron + backlog reconciliation" },
                ]}
              />
              <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
                <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-foreground font-medium">Minimum data</dt>
                  <dd>At least one indexed block range per chain</dd>
                  <dt className="text-foreground font-medium">Required sources</dt>
                  <dd>Block explorer event logs with valid ABI decoding</dd>
                  <dt className="text-foreground font-medium">Failure behavior</dt>
                  <dd>Falls back to last-known freeze ledger; stale-data banner shown</dd>
                </dl>
              </div>
              <WorkedExample summary="Worked example: blacklist event reconciliation">
                <p className="font-mono">Event: AddedBlackList(0xabc...def) on USDT (Ethereum), block 19,234,567</p>
                <p className="font-mono">Ledger update: +1 frozen address, total frozen balance recalculated from on-chain balanceOf</p>
                <p className="font-mono">Cross-chain: Tron USDT freeze count unchanged → combined freeze count increments by 1</p>
                <p>Result: <span className="text-foreground">Dashboard shows updated freeze count and reconciled total across chains.</span></p>
              </WorkedExample>
              <MethodologyDetails summary="Technical details: freeze ledger reconciliation">
                <div className="space-y-3">
                  <p>The blacklist tracker maintains a reconciled freeze ledger that merges event-driven updates with periodic full-state snapshots. Each cron run processes new events since the last indexed block, then reconciles against the cumulative ledger.</p>
                  <p>Backlog sync handles gaps from missed cron runs or RPC failures by replaying events from the last confirmed cursor. Tron events use a separate ingestion path due to the TRC-20 event format differences.</p>
                  <p>The public-facing freeze totals combine per-chain counts into a single figure. When the tracker detects an Unfreeze or DestroyedBlackFunds event, it decrements the affected chain&rsquo;s count and recalculates the aggregate.</p>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
