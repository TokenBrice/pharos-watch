"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSafetyGrades } from "@/hooks/api-hooks";
import { checkDonorWallet, isWalletAddress, resolveDonorWalletGrades } from "@/lib/donor-wallet-check";
import { formatAddress, formatDecimal } from "@shared/lib/format";
import type { Donation } from "@shared/lib/funding/schema";
import { DONOR_API_KEY_MIN_USD } from "@shared/lib/ops-limits";
import { ApiDisclosure } from "./api-disclosure";

/** Minimal EIP-1193 surface: the check only reads an address and never signs. */
interface EthereumProvider {
  request(args: { method: string }): Promise<unknown>;
}

function firstAccount(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const account = result[0];
  return typeof account === "string" && isWalletAddress(account) ? account : null;
}

function formatUsd(value: number): string {
  return `$${formatDecimal(value, 2, 2)}`;
}

/**
 * Advisory wallet check for the `#claim` section: the committed ledger rows
 * from the build plus the live free-lane grades, fetched only once a visitor
 * asks. It never signs and never calls the claim route.
 */
export function DonorWalletCheck({
  donations,
  chainNames,
  ledgerDate,
}: {
  donations: readonly Donation[];
  chainNames: Readonly<Record<string, string>>;
  ledgerDate: string;
}) {
  const [input, setInput] = useState("");
  const [checkedAddress, setCheckedAddress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readingWallet, setReadingWallet] = useState(false);
  const gradesQuery = useSafetyGrades({ enabled: checkedAddress !== null });
  const { data: gradesData, isError: gradesError, isLoading: gradesLoading } = gradesQuery;
  const { state: gradesState, gradesById } = useMemo(
    () => resolveDonorWalletGrades({ data: gradesData, isError: gradesError, isLoading: gradesLoading }),
    [gradesData, gradesError, gradesLoading],
  );
  const result = useMemo(
    () => (checkedAddress ? checkDonorWallet(checkedAddress, donations, gradesById) : null),
    [checkedAddress, donations, gradesById],
  );

  function check(address: string) {
    const trimmed = address.trim();
    if (!isWalletAddress(trimmed)) {
      setNotice("Enter a wallet address: 0x followed by 40 hex characters.");
      return;
    }
    setNotice(null);
    setCheckedAddress(trimmed.toLowerCase());
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    check(input);
  }

  async function handleUseWallet() {
    const provider = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (!provider || typeof provider.request !== "function") {
      setNotice("No browser wallet found. Paste the address instead.");
      return;
    }
    setReadingWallet(true);
    try {
      const account = firstAccount(await provider.request({ method: "eth_accounts" }))
        ?? firstAccount(await provider.request({ method: "eth_requestAccounts" }));
      if (!account) {
        setNotice("The wallet shared no address. Paste it instead.");
        return;
      }
      setInput(account);
      check(account);
    } catch (error) {
      const rejected = typeof error === "object" && error !== null && "code" in error && error.code === 4001;
      setNotice(rejected ? "Wallet request declined. Paste the address instead." : "The wallet did not respond. Paste the address instead.");
    } finally {
      setReadingWallet(false);
    }
  }

  return (
    <ApiDisclosure summary="Already donated? Check a wallet">
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="donor-wallet-address" className="sr-only">
          Wallet address
        </label>
        <Input
          id="donor-wallet-address"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={notice !== null && !isWalletAddress(input.trim())}
          className="font-mono text-foreground"
        />
        <div className="flex gap-2">
          <Button type="submit" variant="outline" size="sm" className="h-9">
            Check
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 whitespace-nowrap"
            disabled={readingWallet}
            onClick={() => void handleUseWallet()}
          >
            Use my wallet
          </Button>
        </div>
      </form>
      {notice ? <p className="mt-2 text-sm text-foreground">{notice}</p> : null}

      {/* Always mounted so screen readers announce the result when it appears. */}
      <div role="status" aria-live="polite">
        {result && checkedAddress ? (
          <div className="mt-3 space-y-2">
            <p className="font-mono text-xs text-muted-foreground">{formatAddress(checkedAddress)}</p>
            {result.verdict === "no-donations" ? (
              <p className="text-foreground">
                No donations from this wallet in the ledger as of{" "}
                <span className="pharos-numeric whitespace-nowrap">{ledgerDate}</span>. Donations sent after that join
                at the next Sunday update.
              </p>
            ) : gradesState === "loading" ? (
              <p>Loading current grades.</p>
            ) : (
              <>
                {gradesState === "ready" ? (
                  <p className="text-foreground">
                    <span className="pharos-numeric">{formatUsd(result.qualifyingUsd)}</span> of $
                    {DONOR_API_KEY_MIN_USD} in qualifying donations as of{" "}
                    <span className="pharos-numeric whitespace-nowrap">{ledgerDate}</span>.{" "}
                    {result.verdict === "eligible"
                      ? "Enough to claim."
                      : result.verdict === "unconfirmed"
                        ? "Eligibility cannot be confirmed until the missing grades return."
                        : `Short by ${formatUsd(DONOR_API_KEY_MIN_USD - result.qualifyingUsd)}.`}
                  </p>
                ) : (
                  // No sum without grades: an unknown total is not $0 (R1).
                  <p className="text-foreground">
                    {gradesState === "held" ? "Grades are on hold and claims are paused" : "Grades unavailable right now"},
                    so eligibility cannot be confirmed. Donations as of{" "}
                    <span className="pharos-numeric whitespace-nowrap">{ledgerDate}</span>:
                  </p>
                )}
                <ul className="space-y-1">
                  {result.rows.map((row) => (
                    <li key={row.key} className="flex flex-wrap gap-x-2">
                      <span>{chainNames[row.chain] ?? row.chain}</span>
                      <span className="text-foreground">{row.asset}</span>
                      <span className="pharos-numeric text-foreground">{formatUsd(row.usd)}</span>
                      <span>{row.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="pharos-meta">The claim checks again when you sign.</p>
          </div>
        ) : null}
      </div>
    </ApiDisclosure>
  );
}
