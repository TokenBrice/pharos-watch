import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG_PATH,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/blacklist-tracker-version";
import {
  MethodologySectionShell,
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
                USDG, RLUSD, U, USDtb, A7A5, FDUSD, BRZ, AUSD, MNEE, EURI, USDQ, USDO, USDX, AID, and TGBP contracts, including blacklist, unblacklist, block/unblock, account
                pause/unpause, and destroy/wipe actions across supported EVM and Tron networks.
              </p>
              <p>
                Methodology revisions document changes to event coverage, cross-chain decoding behavior, cursor safety
                policies, event-time amount attribution rules, and the separate freeze-ledger snapshot used for the public
                summary and quarterly chart, including the reconciled `kyc.rip` / `stables.rip` bootstrap for ETH USDC,
                ETH USDT, and TRON USDT. Non-USD or commodity-denominated assets use coin-specific price-cache entries
                when Pharos reports USD frozen value.
              </p>
          </MethodologySectionShell>
  );
}
