import Link from "next/link";
import { DonorKeyClaim } from "@/components/donor-key-claim";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import type { DonorKeyQualifyingCoin } from "@/lib/donor-key-qualifying-coins";
import { CHAIN_META } from "@shared/types/chain-identity";
import { formatProseList } from "@shared/lib/format";
import { DONOR_KEY_QUALIFYING_STABLECOINS, type DonorKeyGradeStatus } from "@shared/lib/funding/donor-eligibility";
import type { Donation } from "@shared/lib/funding/schema";
import { DONOR_API_KEY_MIN_USD } from "@shared/lib/ops-limits";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_ACCESS_X_HANDLE,
  API_ACCESS_X_URL,
  API_PAGE_ANCHORS,
  DONOR_KEY_CLAIMS_OPEN,
} from "@shared/lib/public-api-contract";
import { ApiDisclosure } from "./api-disclosure";
import { DonorWalletCheck } from "./donor-wallet-check";

const STEP_CLASS_NAME = "border-t border-border/55 pt-4";
const STEP_NUMBER_CLASS_NAME = "pharos-numeric text-xs font-semibold text-muted-foreground";
const STEP_TITLE_CLASS_NAME = "mt-2 text-sm font-semibold text-foreground";
const STEP_BODY_CLASS_NAME = "mt-1 text-sm leading-relaxed text-muted-foreground";
const TERMS_LIST_CLASS_NAME = "list-disc space-y-1.5 pl-5";

// An ungraded coin gets its own group and no badge: unavailable is never "does not count" (R1).
// The first rendered group label also carries the grades date.
const COIN_GROUPS: readonly { status: DonorKeyGradeStatus; label: string }[] = [
  { status: "counts", label: "Counts now" },
  { status: "outside-band", label: "Does not count now" },
  { status: "unavailable", label: "Grade unavailable" },
];

/**
 * Networks per coin, from the reviewed contracts: coins on every funding network
 * are named once, the rest are grouped by their network list.
 */
function describeCoinNetworks(): string {
  const allChains = [...new Set(DONOR_KEY_QUALIFYING_STABLECOINS.flatMap((coin) => Object.keys(coin.contracts)))];
  const chainNames = allChains.map((chain) => CHAIN_META[chain]?.name ?? chain);
  const everywhere: string[] = [];
  const byNetworks = new Map<string, string[]>();
  for (const coin of DONOR_KEY_QUALIFYING_STABLECOINS) {
    const networks = chainNames.filter((_, index) => allChains[index] in coin.contracts);
    if (networks.length === allChains.length) {
      everywhere.push(coin.label);
      continue;
    }
    const key = networks.join(", ");
    byNetworks.set(key, [...(byNetworks.get(key) ?? []), coin.label]);
  }
  const sentences = [...byNetworks].map(([networks, labels]) => `${labels.join(", ")}: ${networks}.`);
  if (everywhere.length > 0) {
    sentences.unshift(`${formatProseList(everywhere)} count on ${formatProseList(chainNames)}.`);
  }
  return [...sentences, "Bridged or look-alike tokens never count."].join(" ");
}

const COIN_NETWORKS_NOTE = describeCoinNetworks();

export function SupporterClaimSteps({
  coins,
  gradesAsOf,
  donations,
  chainNames,
  ledgerReconciledDate,
}: {
  coins: readonly DonorKeyQualifyingCoin[];
  gradesAsOf: string;
  donations: readonly Donation[];
  chainNames: Readonly<Record<string, string>>;
  ledgerReconciledDate: string;
}) {
  const groups = COIN_GROUPS
    .map((group) => ({ ...group, coins: coins.filter((coin) => coin.status === group.status) }))
    .filter((group) => group.coins.length > 0);
  const anyCounting = coins.some((coin) => coin.status === "counts");
  return (
    <section id={API_PAGE_ANCHORS.claim} aria-labelledby="claim-title" className="scroll-mt-20 space-y-6">
      <h2 id="claim-title" className="text-2xl font-semibold tracking-tight text-foreground">
        Claim your supporter key
      </h2>
      <ol className="grid gap-6 sm:grid-cols-3 sm:gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <li className={STEP_CLASS_NAME}>
          <p className={STEP_NUMBER_CLASS_NAME}>01</p>
          <h3 className={STEP_TITLE_CLASS_NAME}>Donate</h3>
          <p className={STEP_BODY_CLASS_NAME}>
            {anyCounting
              ? `Send $${DONOR_API_KEY_MIN_USD} or more in a stablecoin that counts now, from a wallet you can sign with.`
              : "No listed stablecoin counts at its current grade."}
          </p>
          <dl className="mt-3 space-y-2">
            {groups.map((group, index) => (
              <div key={group.status}>
                <dt className="text-xs text-muted-foreground">
                  {group.label}
                  {index === 0 ? (
                    <>
                      {" "}
                      (grades as of <span className="pharos-numeric whitespace-nowrap">{gradesAsOf}</span>)
                    </>
                  ) : null}
                </dt>
                <dd>
                  <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {group.coins.map((coin) => (
                      <li
                        key={coin.stablecoinId}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground"
                      >
                        {coin.label}
                        {coin.grade ? <SafetyGradeBadge grade={coin.grade} size="xs" /> : null}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Each coin counts only on its listed networks. Exchange withdrawals and Giveth streams cannot claim.
            Smart-contract wallets cannot claim yet.
          </p>
          <Link href="/funding/#how-to-support" className="pharos-prose-link mt-2 inline-block text-sm text-foreground">
            Donate on the funding page
          </Link>
        </li>
        <li className={STEP_CLASS_NAME}>
          <p className={STEP_NUMBER_CLASS_NAME}>02</p>
          <h3 className={STEP_TITLE_CLASS_NAME}>Wait for Sunday&apos;s update</h3>
          <p className={STEP_BODY_CLASS_NAME}>
            The donor list is updated every Sunday. This page includes donations sent before{" "}
            <span className="pharos-numeric">{ledgerReconciledDate}</span>.
          </p>
        </li>
        <li className={STEP_CLASS_NAME}>
          <p className={STEP_NUMBER_CLASS_NAME}>03</p>
          <h3 className={STEP_TITLE_CLASS_NAME}>Sign and copy</h3>
          <p className={STEP_BODY_CLASS_NAME}>
            Sign a text message with the donating wallet. No transaction, no gas. The key is shown once.
          </p>
        </li>
      </ol>

      {DONOR_KEY_CLAIMS_OPEN ? (
        <div>
          <DonorKeyClaim />
          <div className="mt-4">
            <DonorWalletCheck donations={donations} chainNames={chainNames} ledgerDate={ledgerReconciledDate} />
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Supporter key claims are paused.
        </p>
      )}

      <div className="grid items-start gap-3 md:grid-cols-2">
        <ApiDisclosure summary="Which donations count">
          <ul className={TERMS_LIST_CLASS_NAME}>
            <li>
              Donations are valued in USD at receipt and summed per wallet. Exactly ${DONOR_API_KEY_MIN_USD} qualifies.
            </li>
            <li>A later grade change does not revoke an issued key.</li>
            <li>ETH and other tokens do not count.</li>
            <li>{COIN_NETWORKS_NOTE}</li>
            <li>Claims pause while the Safety Score publication is held or unavailable.</li>
          </ul>
        </ApiDisclosure>
        <ApiDisclosure summary="Lost key, privacy and terms">
          <ul className={TERMS_LIST_CLASS_NAME}>
            <li>One key per wallet. Signing again does not rotate it.</li>
            <li>
              Lost or leaked key: message{" "}
              <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
                @{API_ACCESS_TELEGRAM_HANDLE} on Telegram
              </a>{" "}
              or DM{" "}
              <a href={API_ACCESS_X_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
                @{API_ACCESS_X_HANDLE} on X
              </a>
              . The donating wallet is verified before the key is rotated, and the messages are deleted afterwards.
              Check the exact handle. Pharos never asks for wallet credentials or payment by direct message.
            </li>
            <li>
              Claiming stores the wallet address, key prefix and claim time. See the{" "}
              <Link href="/privacy/" className="pharos-prose-link">
                privacy policy
              </Link>
              .
            </li>
          </ul>
        </ApiDisclosure>
      </div>
    </section>
  );
}
