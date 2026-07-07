"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Copy, ExternalLink } from "lucide-react";
import {
  SECTION_DIVIDER_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import { buildContractDeploymentParts } from "@/lib/contract-deployment-summary";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { CHAIN_META } from "@shared/lib/chains";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import type { StablecoinMeta } from "@shared/types";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];

function getContractKey(contract: ContractDeployment): string {
  return `${contract.chain}:${contract.address}`;
}

export function ContractDeployments({
  coinId,
  contracts,
  compact = false,
}: {
  coinId: string;
  contracts: ContractDeployment[];
  /**
   * Rail rendering (Figma coin template): single-column rows, shorter
   * preview, and no `#contracts` anchor — the in-flow Key Info instance
   * owns the deep-link id so dual-rendering never duplicates it.
   */
  compact?: boolean;
}) {
  const [openContractKey, setOpenContractKey] = useState<string | null>(null);
  const [showAllContractsMobile, setShowAllContractsMobile] = useState(false);
  const [showAllContractsDesktop, setShowAllContractsDesktop] = useState(false);
  // Keyed by chain+address: some coins deploy twice on one chain, and a
  // chain-only key would flash the copied check on both rows.
  const [copiedContract, setCopiedContract] = useState<string | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  if (contracts.length === 0) return null;

  const contractSummary = buildContractDeploymentSummary(contracts);
  const mobileContractsPreview = contracts.slice(0, 6);
  const visibleMobileContracts = showAllContractsMobile ? contracts : mobileContractsPreview;
  const hiddenMobileContractCount = Math.max(contracts.length - mobileContractsPreview.length, 0);
  // Desktop shows labeled rows (chain name + address + actions), not an
  // icon-only wall -- recognition fails past the top-10 chain logos. Preview 9
  // keeps the card compact for coins with dozens of deployments.
  const desktopContractsPreview = contracts.slice(0, compact ? 5 : 9);
  const visibleDesktopContracts = showAllContractsDesktop ? contracts : desktopContractsPreview;
  const hiddenDesktopContractCount = Math.max(contracts.length - desktopContractsPreview.length, 0);

  const openContract = contracts.find((contract) => getContractKey(contract) === openContractKey) ?? null;
  const quickCopyContract = openContract ?? contracts[0] ?? null;

  function copyContractAddress(chain: string, address: string) {
    void navigator.clipboard?.writeText(address);
    trackEvent("contract_copied", { coin_id: coinId, chain });
    setCopiedContract(`${chain}:${address}`);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedContract(null), 2000);
  }

  return (
    <div
      id={compact ? undefined : "contracts"}
      className={compact ? undefined : cn(SECTION_SCROLL_MT, SECTION_DIVIDER_CLASS)}
    >
      <p className="pharos-kicker mb-1.5">
        Contract Deployments{compact ? ` · ${contracts.length}` : ""}
      </p>
      {!compact && contractSummary && (
        <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{contractSummary}</p>
      )}
      {quickCopyContract ? (
        <ContractDetailRow
          contract={quickCopyContract}
          copied={copiedContract === `${quickCopyContract.chain}:${quickCopyContract.address}`}
          label={openContract ? "Selected contract" : "Primary contract"}
          onCopy={copyContractAddress}
        />
      ) : null}
      <div className="grid grid-cols-5 gap-1.5 min-[360px]:grid-cols-6 sm:hidden">
        {visibleMobileContracts.map((c) => {
          const contractKey = getContractKey(c);
          return (
            <ContractChainButton
              key={contractKey}
              chainKey={c.chain}
              address={c.address}
              isOpen={openContractKey === contractKey}
              onToggle={() => setOpenContractKey(openContractKey === contractKey ? null : contractKey)}
            />
          );
        })}
      </div>
      <div className="hidden sm:block">
        <div
          className={`grid gap-1.5 ${
            compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3"
          } ${showAllContractsDesktop ? "max-h-96 overflow-y-auto pr-1" : ""}`}
        >
          {visibleDesktopContracts.map((c) => (
            <ContractLabeledRow
              key={`${c.chain}-${c.address}`}
              contract={c}
              copied={copiedContract === `${c.chain}:${c.address}`}
              onCopy={copyContractAddress}
            />
          ))}
        </div>
        {hiddenDesktopContractCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllContractsDesktop((current) => !current)}
            className="pharos-focus-ring mt-2 inline-flex min-h-9 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {showAllContractsDesktop ? "Show less" : `Show all ${contracts.length} chains`}
          </button>
        )}
      </div>
      {hiddenMobileContractCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            if (
              showAllContractsMobile &&
              openContractKey &&
              !mobileContractsPreview.some((contract) => getContractKey(contract) === openContractKey)
            ) {
              setOpenContractKey(null);
            }
            setShowAllContractsMobile((current) => !current);
          }}
          className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground sm:hidden"
        >
          {showAllContractsMobile ? "Show less" : `Show all ${contracts.length} chains`}
        </button>
      ) : null}
    </div>
  );
}

/* Copy->Check crossfade with the success ring, shared by the mobile and desktop
 * contract rows. Callers pass a static iconClass literal (Tailwind purge). */
function ContractCopyIcons({ copied, iconClass }: { copied: boolean; iconClass: string }) {
  return (
    <>
      <Copy
        className={`pharos-copy-icon absolute ${iconClass} ${copied ? "opacity-0" : "opacity-100"}`}
        aria-hidden="true"
      />
      <Check
        className={`pharos-copy-icon absolute ${iconClass} text-emerald-500 ${
          copied ? "opacity-100" : "opacity-0"
        }`}
        aria-hidden="true"
      />
      {copied ? <span className="pharos-copy-ring" aria-hidden="true" /> : null}
    </>
  );
}

function ContractDetailRow({
  contract,
  copied,
  label,
  onCopy,
}: {
  contract: ContractDeployment;
  copied: boolean;
  label?: string;
  onCopy: (chain: string, address: string) => void;
}) {
  const { chain, chainName, explorerUrl } = deriveContractInfo(contract);

  return (
    <div className="mb-3 rounded-lg border border-border/50 bg-background/55 px-3 py-2 sm:hidden">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          {label ? (
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          ) : null}
          <Link
            href={`/chains/${contract.chain}/`}
            className="pharos-focus-ring mt-0.5 inline-flex max-w-full rounded-sm text-sm font-medium hover:underline"
          >
            <span className="truncate">{chainName}</span>
          </Link>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{formatAddress(contract.address)}</p>
        </div>
        <button
          type="button"
          onClick={() => onCopy(contract.chain, contract.address)}
          className="pharos-focus-ring relative inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          title="Copy address"
          aria-label={`Copy ${chainName} contract address`}
        >
          <span className="relative inline-flex h-4 w-4 items-center justify-center">
            <ContractCopyIcons copied={copied} iconClass="h-4 w-4" />
          </span>
        </button>
      </div>
      {explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring mt-2 inline-flex min-h-10 items-center gap-1 rounded-md text-xs text-frost-blue hover:underline"
        >
          View on {chain?.name ? `${chain.name} explorer` : "explorer"}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

/* Desktop contract row: chain identity stays readable (logo + name) and the
 * two verification actions (copy, explorer) sit inline -- recognition over
 * recall for the long tail of chains the bare icon wall hid. */
function ContractLabeledRow({
  contract,
  copied,
  onCopy,
}: {
  contract: ContractDeployment;
  copied: boolean;
  onCopy: (chain: string, address: string) => void;
}) {
  const { chain, chainName, explorerUrl } = deriveContractInfo(contract);

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/40 bg-background/40 py-1 pl-2.5 pr-1">
      {chain?.logoPath ? (
        <Image
          src={chain.logoPath}
          alt=""
          width={18}
          height={18}
          className={`h-[18px] w-[18px] shrink-0 rounded-full object-contain${chain.darkInvert ? " dark:invert" : ""}`}
        />
      ) : (
        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
          {chainName.charAt(0).toUpperCase()}
        </span>
      )}
      <Link
        href={`/chains/${contract.chain}/`}
        className="pharos-focus-ring min-w-0 shrink-0 rounded-sm text-sm font-medium hover:underline"
      >
        <span className="block max-w-[9rem] truncate">{chainName}</span>
      </Link>
      <span className="ml-auto truncate font-mono text-xs text-muted-foreground" title={contract.address}>
        {formatAddress(contract.address)}
      </span>
      <button
        type="button"
        onClick={() => onCopy(contract.chain, contract.address)}
        className="pharos-focus-ring relative inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        title="Copy address"
        aria-label={`Copy ${chainName} contract address`}
      >
        <ContractCopyIcons copied={copied} iconClass="h-3.5 w-3.5" />
      </button>
      {explorerUrl ? (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          title={`View on ${chainName} explorer`}
          aria-label={`View ${chainName} contract on explorer`}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

function deriveContractInfo(contract: ContractDeployment) {
  const chain = CHAIN_META[contract.chain];
  const chainName = chain?.name ?? contract.chain;
  const explorerUrl = buildExplorerUrl({
    chainKey: contract.chain,
    entityType: "contract",
    value: contract.address,
  });

  return { chain, chainName, explorerUrl };
}

function buildContractDeploymentSummary(contracts: StablecoinMeta["contracts"]): string | null {
  const { count, chainNames, remaining, deploymentLabel } = buildContractDeploymentParts(contracts);
  if (count === 0) return null;
  const remainingSuffix = remaining > 0 ? `, plus ${remaining} more` : "";
  const formattedChains =
    chainNames.length <= 1
      ? (chainNames[0] ?? "")
      : chainNames.length === 2
        ? `${chainNames[0]} and ${chainNames[1]}`
        : `${chainNames.slice(0, -1).join(", ")}, and ${chainNames[chainNames.length - 1]}`;
  return `${count} ${deploymentLabel} tracked across ${formattedChains}${remainingSuffix}.`;
}

function ContractChainButton({
  chainKey,
  address,
  isOpen,
  onToggle,
}: {
  chainKey: string;
  address: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const chain = CHAIN_META[chainKey];

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`pharos-focus-ring flex size-11 items-center justify-center rounded-full ring-2 transition-colors ${
        isOpen ? "ring-foreground" : "ring-transparent hover:ring-muted-foreground/30"
      }`}
      title={chain?.name ?? chainKey}
      aria-label={`${chain?.name ?? chainKey} contract ${address}`}
    >
      {chain?.logoPath ? (
        <Image
          src={chain.logoPath}
          alt={chain.name}
          width={28}
          height={28}
          className={`h-7 w-7 rounded-full object-contain${chain.darkInvert ? " dark:invert" : ""}`}
        />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-bold text-muted-foreground">
          {(chain?.name ?? chainKey).charAt(0).toUpperCase()}
        </div>
      )}
    </button>
  );
}
