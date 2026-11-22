"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Copy, ExternalLink, Maximize2, Search } from "lucide-react";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import {
  DETAIL_HEADER_ICON_BUTTON_CLASS,
  DETAIL_MODULE_BODY_CLASS,
  DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS,
  DETAIL_MODULE_TITLE_CLASS,
  SECTION_SCROLL_MT,
} from "@/components/stablecoin-detail/section-title-class";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { buildContractDeploymentParts } from "@/lib/contract-deployment-summary";
import { trackEvent } from "@/lib/analytics";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";
import { CHAIN_META } from "@shared/types/chain-identity";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];
type ContractInfo = ReturnType<typeof deriveContractInfo>;
type ContractRowVariant = "compact" | "detail" | "labeled";

/**
 * In-flow preview size: 12 fills whole rows of the 2-, 3- and 4-column tile
 * grids, so a coin with more deployments never leaves an orphan tile.
 */
const CONTRACT_PREVIEW_COUNT = 12;

/**
 * A last tile alone on its row spans it instead of leaving blank cells, per
 * breakpoint column count (2 at sm, 3 at md, 4 at lg); each wider breakpoint
 * resets the narrower one's span.
 */
function orphanSpanClass(count: number): string {
  return cn(
    count % 2 === 1 && "sm:col-span-2",
    count % 3 === 1 ? "md:col-span-3" : "md:col-span-1",
    count % 4 === 1 ? "lg:col-span-4" : "lg:col-span-1",
  );
}

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
   * preview, and no `#contracts` anchor — the in-flow (`xl:hidden`) instance
   * owns the deep-link id so dual-rendering never duplicates it.
   */
  compact?: boolean;
}) {
  const [openContractKey, setOpenContractKey] = useState<string | null>(null);
  // Rail searchable modal state (replaces inline expansion that blew out rail height on multi-chain coins).
  const [modalOpen, setModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Keyed by chain+address: some coins deploy twice on one chain, and a
  // chain-only key would flash the copied check on both rows.
  const [copiedContract, setCopiedContract] = useState<string | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredContracts = useMemo(() => {
    if (!normalizedSearch) return contracts;
    return contracts.filter((contract) => {
      const chainName = (CHAIN_META[contract.chain]?.name ?? contract.chain).toLowerCase();
      return (
        chainName.includes(normalizedSearch)
        || contract.chain.toLowerCase().includes(normalizedSearch)
        || contract.address.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [contracts, normalizedSearch]);

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  if (contracts.length === 0) return null;

  // This card keeps its literal H2s instead of `StablecoinModuleTitle` (it
  // shows no logo/ticker), so the heading takes the tracked symbol itself.
  // An id outside the tracked registry keeps the plain `Contracts` heading.
  const coinSymbol = CLIENT_TRACKED_META_BY_ID.get(coinId)?.symbol ?? null;
  const contractSummary = buildContractDeploymentSummary(contracts);
  // Every preview is labeled (logo + chain name), not an icon-only wall --
  // recognition fails past the top-10 chain logos, and two chains can share a
  // logo (HyperEVM, Hyperliquid L1). The in-flow card's closed fold carries
  // the complete recorded list.
  const desktopContractsPreview = contracts.slice(0, compact ? 4 : CONTRACT_PREVIEW_COUNT);
  const hiddenDesktopContractCount = Math.max(contracts.length - desktopContractsPreview.length, 0);

  const openContract = contracts.find((contract) => getContractKey(contract) === openContractKey) ?? null;
  const quickCopyContract = openContract ?? contracts[0] ?? null;

  async function copyContractAddress(chain: string, address: string) {
    const result = await copyText(address);
    if (!result.ok) return;
    trackEvent("contract_copied", { coin_id: coinId, chain });
    setCopiedContract(`${chain}:${address}`);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedContract(null), 2000);
  }

  if (compact) {
    const handleModalOpenChange = (nextOpen: boolean) => {
      setModalOpen(nextOpen);
      if (!nextOpen) setSearchQuery("");
    };
    return (
      <Dialog open={modalOpen} onOpenChange={handleModalOpenChange}>
        <section
          // The in-flow instance owns `#contracts` but is xl:hidden;
          // the passport strip's hash jump falls back to this visible twin.
          data-anchor-twin="contracts"
          className={cn("pharos-card-shell overflow-hidden", SECTION_SCROLL_MT)}
          aria-label={`Contracts, ${contracts.length} deployments`}
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <h2 className={DETAIL_MODULE_TITLE_CLASS}>
                {coinSymbol ? (
                  <>
                    <span className="sr-only">{coinSymbol}</span>{" "}
                  </>
                ) : null}
                Contracts
              </h2>
              <span className="text-muted-foreground/50" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-xs text-muted-foreground">{contracts.length}</span>
            </div>
            {hiddenDesktopContractCount > 0 ? (
              <DialogTrigger asChild>
                <button
                  type="button"
                  className={DETAIL_HEADER_ICON_BUTTON_CLASS}
                  aria-label={`Search all ${contracts.length} contract deployments`}
                  title={`All ${contracts.length} deployments`}
                >
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </DialogTrigger>
            ) : null}
          </div>
          <div className="space-y-1.5 px-4 py-3">
            {desktopContractsPreview.map((contract) => (
              <CompactContractRow
                key={`${contract.chain}-${contract.address}`}
                contract={contract}
                copied={copiedContract === `${contract.chain}:${contract.address}`}
                onCopy={copyContractAddress}
              />
            ))}
            {hiddenDesktopContractCount > 0 ? (
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="pharos-focus-ring mt-1 flex min-h-9 w-full items-center justify-between rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground"
                >
                  <span>All {contracts.length} deployments</span>
                  <span className="font-mono text-2xs">+{hiddenDesktopContractCount} more</span>
                </button>
              </DialogTrigger>
            ) : null}
          </div>
        </section>
        {hiddenDesktopContractCount > 0 ? (
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {coinSymbol ? `${coinSymbol} contract deployments` : "Contract deployments"} ({contracts.length})
              </DialogTitle>
              <DialogDescription>
                Filter by chain name or contract address. Copy an address or inspect it on its block explorer.
              </DialogDescription>
            </DialogHeader>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search chains or addresses…"
                aria-label="Filter contract deployments"
                className="pharos-focus-ring h-10 w-full rounded-md border border-border bg-background pr-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
              {filteredContracts.length > 0 ? (
                filteredContracts.map((contract) => (
                  <CompactContractRow
                    key={`${contract.chain}-${contract.address}`}
                    contract={contract}
                    copied={copiedContract === `${contract.chain}:${contract.address}`}
                    onCopy={copyContractAddress}
                  />
                ))
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No deployments matching &ldquo;{searchQuery.trim()}&rdquo;.
                </p>
              )}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    );
  }

  return (
    <section
      id="contracts"
      className={cn(DETAIL_MODULE_SHELL_CLASS, SECTION_SCROLL_MT)}
      aria-label={`Contracts, ${contracts.length} deployments`}
    >
      <div className={DETAIL_MODULE_HEADER_CLASS}>
        <div className="flex items-center gap-2">
          <h2 className={DETAIL_MODULE_TITLE_CLASS}>
            {coinSymbol ? (
              <>
                <span className="sr-only">{coinSymbol}</span>{" "}
              </>
            ) : null}
            Contracts
          </h2>
          <span className="text-muted-foreground/50" aria-hidden="true">
            ·
          </span>
          <span className="font-mono text-xs text-muted-foreground">{contracts.length}</span>
        </div>
      </div>
      <div className={DETAIL_MODULE_BODY_CLASS}>
      {contractSummary && <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{contractSummary}</p>}
      {quickCopyContract ? (
        <ContractDetailRow
          contract={quickCopyContract}
          copied={copiedContract === `${quickCopyContract.chain}:${quickCopyContract.address}`}
          label={openContract ? "Selected contract" : "Primary contract"}
          onCopy={copyContractAddress}
        />
      ) : null}
      {/* Balanced wrap: chips are inline boxes, so the last row never holds a lone chip. */}
      <div className="-mt-1.5 text-balance sm:hidden" data-contract-chips="">
        {desktopContractsPreview.map((c) => {
          const contractKey = getContractKey(c);
          return (
            <ContractChainButton
              key={contractKey}
              chainKey={c.chain}
              address={c.address}
              // A chain deployed twice names each chip by its address too.
              repeatedChain={desktopContractsPreview.filter((other) => other.chain === c.chain).length > 1}
              isOpen={openContractKey === contractKey}
              onToggle={() => setOpenContractKey(openContractKey === contractKey ? null : contractKey)}
            />
          );
        })}
      </div>
      <div className="hidden gap-1.5 sm:grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {desktopContractsPreview.map((c, index) => (
          <ContractLabeledRow
            key={`${c.chain}-${c.address}`}
            className={index === desktopContractsPreview.length - 1 ? orphanSpanClass(desktopContractsPreview.length) : undefined}
            contract={c}
            copied={copiedContract === `${c.chain}:${c.address}`}
            onCopy={copyContractAddress}
          />
        ))}
      </div>
      {/* The complete recorded list is a closed native fold that replaces the
          old show-all toggle: every address is crawlable and readable without
          JS, while the card keeps its compact interactive preview. Full
          interactive rows for every deployment were measured at ~1.26 MB of
          HTML on USDC (88 deployments), so this list is deliberately plain
          text with one shared class. */}
      <ModuleDisclosure
        // The SEO archive check (C3) keys on a summary starting "Contract addresses"; the count names the full set.
        label="Contract addresses"
        count={contracts.length}
        className="mt-3"
      >
        <ContractDeploymentAddressList contracts={contracts} />
      </ModuleDisclosure>
      </div>
    </section>
  );
}

/**
 * One plain row per recorded deployment inside the in-flow card's `Contract
 * addresses` fold: chain name, then the unmodified address in registry order.
 * The rail card has no fold (its show-all toggle keeps the byte budget), so
 * rows carry no id and no anchor twin; chain-hub links target `#contracts`.
 */
function ContractDeploymentAddressList({ contracts }: { contracts: ContractDeployment[] }) {
  return (
    <ul className="mt-2 space-y-1 break-all font-mono text-xs text-muted-foreground">
      {contracts.map((contract) => (
        <li key={`${contract.chain}:${contract.address}`}>
          {`${CHAIN_META[contract.chain]?.name ?? contract.chain} ${contract.address}`}
        </li>
      ))}
    </ul>
  );
}

function CompactContractRow({
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
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-background/45 px-2 py-1.5">
      <ContractChainIdentity contract={contract} chain={chain} chainName={chainName} variant="compact" />
      <ContractAddress address={contract.address} variant="compact" />
      <ContractCopyAction contract={contract} chainName={chainName} copied={copied} onCopy={onCopy} variant="compact" />
      <ContractExplorerAction chain={chain} chainName={chainName} explorerUrl={explorerUrl} variant="compact" />
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
        className={`pharos-copy-icon absolute ${iconClass} text-state-positive-solid ${copied ? "opacity-100" : "opacity-0"}`}
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
    <div className="mb-3 pharos-inset px-3 py-2 sm:hidden">
      <div className="flex min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          {label ? (
            <p className="pharos-label">{label}</p>
          ) : null}
          <ContractChainIdentity contract={contract} chain={chain} chainName={chainName} variant="detail" />
          <ContractAddress address={contract.address} variant="detail" />
        </div>
        <ContractCopyAction contract={contract} chainName={chainName} copied={copied} onCopy={onCopy} variant="detail" />
      </div>
      <ContractExplorerAction chain={chain} chainName={chainName} explorerUrl={explorerUrl} variant="detail" />
    </div>
  );
}

/* Desktop contract tile: chain identity stays readable (logo + name) and the
 * two verification actions (copy, explorer) sit inline -- recognition over
 * recall for the long tail of chains the bare icon wall hid. A tile is too
 * narrow for a readable address, so it prints none (the copy action, the
 * explorer link and the fold carry it) and a long chain name truncates
 * before the actions do. */
function ContractLabeledRow({
  contract,
  copied,
  onCopy,
  className,
}: {
  className?: string;
  contract: ContractDeployment;
  copied: boolean;
  onCopy: (chain: string, address: string) => void;
}) {
  const { chain, chainName, explorerUrl } = deriveContractInfo(contract);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border border-border/40 bg-background/40 py-1 pl-2.5 pr-1",
        className,
      )}
      title={contract.address}
    >
      <ContractChainIdentity contract={contract} chain={chain} chainName={chainName} variant="labeled" />
      <ContractCopyAction contract={contract} chainName={chainName} copied={copied} onCopy={onCopy} variant="labeled" />
      <ContractExplorerAction chain={chain} chainName={chainName} explorerUrl={explorerUrl} variant="labeled" />
    </div>
  );
}

function ContractChainIdentity({
  contract,
  chain,
  chainName,
  variant,
}: {
  contract: ContractDeployment;
  chain: ContractInfo["chain"];
  chainName: string;
  variant: ContractRowVariant;
}) {
  if (variant === "detail") {
    return (
      <Link
        href={`/chains/${contract.chain}/`}
        className="pharos-focus-ring mt-0.5 inline-flex max-w-full rounded-sm text-sm font-medium hover:underline"
      >
        <span className="truncate">{chainName}</span>
      </Link>
    );
  }

  const isCompact = variant === "compact";

  return (
    <>
      {chain?.logoPath ? (
        <Image
          src={resolveCompactLogoSrc(chain.logoPath, isCompact ? 20 : 18)!}
          alt=""
          width={isCompact ? 20 : 18}
          height={isCompact ? 20 : 18}
          className={
            isCompact
              ? `h-5 w-5 shrink-0 rounded-full object-contain${chain.darkInvert ? " dark:invert" : ""}`
              : `h-[18px] w-[18px] shrink-0 rounded-full object-contain${chain.darkInvert ? " dark:invert" : ""}`
          }
        />
      ) : (
        <span
          className={
            isCompact
              ? "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-bold text-muted-foreground"
              : "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-bold text-muted-foreground"
          }
        >
          {chainName.charAt(0).toUpperCase()}
        </span>
      )}
      <Link
        href={`/chains/${contract.chain}/`}
        className={
          isCompact
            ? "pharos-focus-ring min-w-0 shrink-0 rounded-sm text-sm font-medium text-foreground hover:underline"
            : "pharos-focus-ring min-w-0 flex-1 rounded-sm text-sm font-medium hover:underline"
        }
      >
        <span className={isCompact ? "block max-w-[7rem] truncate" : "block truncate"}>{chainName}</span>
      </Link>
    </>
  );
}

function ContractAddress({ address, variant }: { address: string; variant: "compact" | "detail" }) {
  if (variant === "detail") {
    return <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{formatAddress(address)}</p>;
  }

  return (
    <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground" title={address}>
      {formatAddress(address)}
    </span>
  );
}

function ContractCopyAction({
  contract,
  chainName,
  copied,
  onCopy,
  variant,
}: {
  contract: ContractDeployment;
  chainName: string;
  copied: boolean;
  onCopy: (chain: string, address: string) => void;
  variant: ContractRowVariant;
}) {
  const onClick = () => onCopy(contract.chain, contract.address);

  if (variant === "detail") {
    return (
      <button
        type="button"
        onClick={onClick}
        className="pharos-focus-ring relative inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
        title="Copy address"
        aria-label={`Copy ${chainName} contract address`}
      >
        <span className="relative inline-flex h-4 w-4 items-center justify-center">
          <ContractCopyIcons copied={copied} iconClass="h-4 w-4" />
        </span>
      </button>
    );
  }

  const isCompact = variant === "compact";

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        isCompact
          ? "pharos-focus-ring relative inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          : "pharos-focus-ring relative inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
      }
      title="Copy address"
      aria-label={`Copy ${chainName} contract address`}
    >
      <ContractCopyIcons copied={copied} iconClass={isCompact ? "h-3 w-3" : "h-3.5 w-3.5"} />
    </button>
  );
}

function ContractExplorerAction({
  chain,
  chainName,
  explorerUrl,
  variant,
}: {
  chain: ContractInfo["chain"];
  chainName: string;
  explorerUrl: string | null;
  variant: ContractRowVariant;
}) {
  if (!explorerUrl) return null;

  if (variant === "detail") {
    return (
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-focus-ring mt-2 inline-flex min-h-10 items-center gap-1 rounded-md text-xs text-brand-accent-text hover:underline"
      >
        View on {chain?.name ? `${chain.name} explorer` : "explorer"}
        <ExternalLink className="h-3 w-3" />
      </a>
    );
  }

  const isCompact = variant === "compact";

  return (
    <a
      href={explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={
        isCompact
          ? "pharos-focus-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          : "pharos-focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
      }
      title={`View on ${chainName} explorer`}
      aria-label={`View ${chainName} contract on explorer`}
    >
      <ExternalLink className={isCompact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" />
    </a>
  );
}

function deriveContractInfo(contract: ContractDeployment) {
  const chain = CHAIN_META[contract.chain];
  const chainName = chain?.name ?? contract.chain;
  const explorerUrl = buildExplorerUrl({
    chainKey: contract.chain,
    deploymentKind: contract.kind,
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

/* Phone chain chip: selects the deployment shown in the detail row above.
 * Labeled like the desktop tiles, in the Key links pill grammar. */
function ContractChainButton({
  chainKey,
  address,
  repeatedChain,
  isOpen,
  onToggle,
}: {
  chainKey: string;
  address: string;
  repeatedChain: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const chain = CHAIN_META[chainKey];
  const chainName = chain?.name ?? chainKey;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isOpen}
      aria-label={`${chainName} contract ${address}`}
      className={
        isOpen
          ? "pharos-focus-ring mt-1.5 mr-1.5 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-foreground px-3 py-1.5 align-top text-xs text-foreground"
          : "pharos-focus-ring mt-1.5 mr-1.5 inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 align-top text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
      }
    >
      {chain?.logoPath ? (
        <Image
          src={resolveCompactLogoSrc(chain.logoPath, 16)!}
          alt=""
          width={16}
          height={16}
          className={`h-4 w-4 shrink-0 rounded-full object-contain${chain.darkInvert ? " dark:invert" : ""}`}
        />
      ) : null}
      {chainName}
      {repeatedChain ? <span className="font-mono text-muted-foreground">{formatAddress(address)}</span> : null}
    </button>
  );
}
