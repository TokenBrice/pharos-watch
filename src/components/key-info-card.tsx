"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, ExternalLink, Globe } from "lucide-react";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { mechanismDiagramFor } from "@/components/stablecoin-detail/mechanism-diagrams";
import { getCoinOverride } from "@/components/stablecoin-detail/mechanism-diagrams/coin-overrides";
import type { MechanismDiagramOptions } from "@/components/stablecoin-detail/mechanism-diagrams/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CHAIN_META } from "@shared/lib/chains";
import { getInfrastructureLabel, getInfrastructureSummary } from "@shared/lib/infrastructure";
import { formatAddress } from "@shared/lib/format";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { trackEvent } from "@/lib/analytics";
import type { MechanismArchetype, StablecoinMeta } from "@shared/types";
import {
  BACKING_BADGE_STYLES,
  BACKING_LABELS,
  GOVERNANCE_BADGE_STYLES,
  GOVERNANCE_LABELS,
  PEG_BADGE_STYLES,
  PEG_LABELS,
  POR_BADGE_STYLES,
  POR_TIER_STYLES,
  getMechanismArchetypeCtaNoun,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { MICA_STATUS_BADGE_STYLES, MICA_STATUS_DESCRIPTIONS } from "@shared/lib/mica";
import { formatLaunchDate } from "@/lib/stablecoin-detail-passport";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy-urls";

type ContractDeployment = NonNullable<StablecoinMeta["contracts"]>[number];

function ClassificationBadgeLink({
  href,
  cls,
  ariaLabel,
  title,
  children,
}: {
  href: string;
  cls: string;
  ariaLabel: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={ariaLabel}
      className={`pharos-focus-ring inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors hover:brightness-110 ${cls}`}
    >
      {children}
    </Link>
  );
}

function AttestorTierBadge({
  proofOfReserves,
}: {
  proofOfReserves: NonNullable<StablecoinMeta["proofOfReserves"]>;
}) {
  if (!proofOfReserves.attestorTier) return null;

  const tierStyle = POR_TIER_STYLES[proofOfReserves.attestorTier];
  const pillClass = `inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${tierStyle.cls}`;
  const pillText = `${tierStyle.label}${proofOfReserves.provider ? ` · ${proofOfReserves.provider}` : ""}`;
  const details: Array<{ label: string; value: string }> = [];

  if (proofOfReserves.provider) details.push({ label: "Provider", value: proofOfReserves.provider });
  if (proofOfReserves.cadence) details.push({ label: "Cadence", value: proofOfReserves.cadence });
  if (proofOfReserves.attestorJurisdiction) {
    details.push({ label: "Jurisdiction", value: proofOfReserves.attestorJurisdiction });
  }
  if (proofOfReserves.attestorLicense) {
    details.push({ label: "License", value: proofOfReserves.attestorLicense });
  }

  if (details.length === 0) {
    return <span className={pillClass}>{pillText}</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`pharos-focus-ring ${pillClass}`}
          aria-label={`Show attestor details for ${tierStyle.label}`}
        >
          {pillText}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-[280px] border-border/70 p-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          {details.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{row.label}</dt>
              <dd className="text-sm leading-snug">{row.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

export function KeyInfoCard({
  meta,
  resolvedMechanismArchetype,
  isWrapper = false,
  parentSymbol,
  parentArchetype,
  variantKind,
}: {
  meta: StablecoinMeta;
  resolvedMechanismArchetype?: MechanismArchetype | null;
  isWrapper?: boolean;
  parentSymbol?: string | null;
  parentArchetype?: MechanismArchetype | null;
  variantKind?: import("@shared/types").VariantKind | null;
}) {
  const [openChain, setOpenChain] = useState<string | null>(null);
  const [showAllContractsMobile, setShowAllContractsMobile] = useState(false);
  const [showAllContractsDesktop, setShowAllContractsDesktop] = useState(false);
  // Keyed by chain+address: some coins deploy twice on one chain, and a
  // chain-only key would flash the copied check on both rows.
  const [copiedContract, setCopiedContract] = useState<string | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const contracts = meta.contracts ?? [];

  const gov = GOVERNANCE_BADGE_STYLES[meta.flags.governance];
  const backing = BACKING_BADGE_STYLES[meta.flags.backing];
  const peg = PEG_BADGE_STYLES[meta.flags.pegCurrency];
  const governanceHref = buildGovernanceTaxonomyUrl(meta.flags.governance);
  const backingHref = buildBackingTaxonomyUrl(meta.flags.backing);
  const pegHref = buildPegLandingUrl(meta.flags.pegCurrency);
  const governanceFullLabel = GOVERNANCE_LABELS[meta.flags.governance] ?? meta.flags.governance;
  const backingFullLabel = BACKING_LABELS[meta.flags.backing] ?? meta.flags.backing;
  const pegFullLabel = PEG_LABELS[meta.flags.pegCurrency] ?? meta.flags.pegCurrency;
  const infrastructures = meta.infrastructures ?? [];
  const infrastructureSummaries = infrastructures.map((value) => ({
    value,
    label: getInfrastructureLabel(value),
    summary: getInfrastructureSummary(value),
    href: buildInfrastructureTaxonomyUrl(value),
  }));
  const effectiveArchetype =
    resolvedMechanismArchetype !== undefined ? resolvedMechanismArchetype : (meta.mechanismArchetype ?? null);
  const diagramOptions: MechanismDiagramOptions = {
    override: getCoinOverride(meta.id),
    ...(isWrapper && parentArchetype
      ? {
          isWrapper: true,
          parentSymbol: parentSymbol ?? undefined,
          parentArchetype,
          variantKind: variantKind ?? undefined,
        }
      : {}),
  };
  const hasDescription = meta.collateral || meta.pegMechanism;
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasLinks = meta.links && meta.links.length > 0;
  const hasContracts = contracts.length > 0;
  const micaStatus = meta.mica ? MICA_STATUS_BADGE_STYLES[meta.mica.status] : null;
  const micaBadgePrefix = meta.status === "frozen" ? "Historical MiCA" : "MiCA";
  // Proof line for the hero passport's "Issued" field; omitted (never faked)
  // while the launchDate population sweep is still filling the dataset.
  const launchDateDisplay = formatLaunchDate(meta.launchDate);
  const contractSummary = buildContractDeploymentSummary(contracts);
  const mobileContractsPreview = contracts.slice(0, 6);
  const visibleMobileContracts = showAllContractsMobile ? contracts : mobileContractsPreview;
  const hiddenMobileContractCount = Math.max(contracts.length - mobileContractsPreview.length, 0);
  // Desktop shows labeled rows (chain name + address + actions), not an
  // icon-only wall — recognition fails past the top-10 chain logos. Preview 9
  // keeps the card compact for coins with dozens of deployments.
  const desktopContractsPreview = contracts.slice(0, 9);
  const visibleDesktopContracts = showAllContractsDesktop ? contracts : desktopContractsPreview;
  const hiddenDesktopContractCount = Math.max(contracts.length - desktopContractsPreview.length, 0);

  const openContract = hasContracts ? (contracts.find((c) => c.chain === openChain) ?? null) : null;
  const quickCopyContract = openContract ?? contracts[0] ?? null;

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  function copyContractAddress(chain: string, address: string) {
    void navigator.clipboard?.writeText(address);
    trackEvent("contract_copied", { coin_id: meta.id, chain });
    setCopiedContract(`${chain}:${address}`);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedContract(null), 2000);
  }

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <DetailSectionTitle>Key Information</DetailSectionTitle>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {meta.name} ({meta.symbol}) is a {governanceFullLabel}, {backingFullLabel} stablecoin pegged to {pegFullLabel}
          .
        </p>
      </CardHeader>
      <CardContent className="space-y-3 sm:space-y-4">
        {/* Classification badges (identity) then external links (navigation) */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {gov && (
              <ClassificationBadgeLink
                href={governanceHref}
                ariaLabel={`Browse ${governanceFullLabel} stablecoins`}
                cls={gov.cls}
              >
                {gov.label}
              </ClassificationBadgeLink>
            )}
            {backing && (
              <ClassificationBadgeLink
                href={backingHref}
                ariaLabel={`Browse ${backingFullLabel} stablecoins`}
                cls={backing.cls}
              >
                {backing.label}
              </ClassificationBadgeLink>
            )}
            {peg &&
              (pegHref ? (
                <ClassificationBadgeLink
                  href={pegHref}
                  ariaLabel={`Browse ${pegFullLabel} stablecoins`}
                  cls={peg.cls}
                >
                  {peg.label}
                </ClassificationBadgeLink>
              ) : (
                <span
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${peg.cls}`}
                >
                  {peg.label}
                </span>
              ))}
            {infrastructureSummaries.map(({ value, label, href }) => (
              <Link
                key={value}
                href={href}
                aria-label={`Browse ${label} infrastructure stablecoins`}
                className={
                  value === "m0"
                    ? "pharos-focus-ring inline-flex items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-700 transition-colors hover:brightness-110 dark:text-violet-400"
                    : "pharos-focus-ring inline-flex items-center rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-frost-blue transition-colors hover:brightness-110"
                }
              >
                {label}
              </Link>
            ))}
            {meta.flags.yieldBearing && (
              <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20">
                Yield-Bearing
              </span>
            )}
            {meta.flags.rwa && (
              <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20">
                RWA
              </span>
            )}
            {!isDecentralized &&
              (meta.proofOfReserves ? (
                meta.proofOfReserves.attestorTier ? (
                  <AttestorTierBadge proofOfReserves={meta.proofOfReserves} />
                ) : (
                  <span
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${POR_BADGE_STYLES[meta.proofOfReserves.type].cls}`}
                  >
                    {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                  </span>
                )
              ) : (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20">
                  No PoR
                </span>
              ))}
          </div>
          {hasLinks && (
            <div className="flex flex-wrap items-center gap-1.5">
              {meta.links?.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
                >
                  {link.label === "Website" ? (
                    <Globe className="h-3.5 w-3.5" />
                  ) : (
                    <ExternalLink className="h-3.5 w-3.5" />
                  )}
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Collateral + Peg Stability. The id anchors (here and on the PoR,
            jurisdiction, and contracts blocks below) are hero passport-strip
            jump targets; scroll-mt clears the mobile sticky summary + section
            banner, while lg+ only needs breathing room. */}
        {hasDescription && (
          <div
            id="mechanism"
            className="grid scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] gap-x-6 gap-y-3 border-t border-border/40 pt-3 sm:pt-4 sm:grid-cols-2 lg:scroll-mt-6"
          >
            {meta.collateral && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Collateral
                </p>
                <p className="text-base leading-relaxed">{meta.collateral}</p>
              </div>
            )}
            {meta.pegMechanism && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Peg Stability
                </p>
                {effectiveArchetype ? (
                  <div className="mb-3 space-y-2">
                    <div className="flex justify-start">
                      {mechanismDiagramFor(effectiveArchetype, meta.symbol, diagramOptions)}
                    </div>
                    <Link
                      href={getMechanismExplainerPath(effectiveArchetype)}
                      className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 py-2 text-xs font-medium text-frost-blue hover:underline sm:min-h-0 sm:py-0"
                    >
                      Learn how {getMechanismArchetypeCtaNoun(effectiveArchetype)} stablecoins work
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </div>
                ) : meta.pegMechanism ? (
                  <div className="mb-3 rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-1.5">
                    <p className="text-sm font-semibold">Custom design — no archetype assigned</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      This coin doesn&apos;t fit the six tracked archetypes. See the description below and the{" "}
                      <Link href="/methodology/" className="pharos-focus-ring text-frost-blue hover:underline">
                        methodology page
                      </Link>{" "}
                      for how Pharos scores it.
                    </p>
                  </div>
                ) : null}
                <p className="text-base leading-relaxed">{meta.pegMechanism}</p>
              </div>
            )}
          </div>
        )}

        {infrastructureSummaries.length > 0 && (
          <div className="border-t border-border/40 pt-3 sm:pt-4 space-y-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Infrastructure
            </p>
            {infrastructureSummaries.map(({ value, label, summary, href }) => (
              <div key={value}>
                <Link
                  href={href}
                  className="pharos-focus-ring rounded-sm text-xs font-semibold text-foreground hover:text-frost-blue"
                >
                  {label}
                </Link>
                <p className="text-sm leading-relaxed text-muted-foreground">{summary}</p>
              </div>
            ))}
          </div>
        )}

        {/* Proof of Reserves + Jurisdiction (2-col on desktop) */}
        {!isDecentralized && (
          <div className="grid gap-x-6 gap-y-3 border-t border-border/40 pt-3 sm:pt-4 sm:grid-cols-2">
            <div
              id="attestation"
              className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Proof of Reserves
              </p>
              {meta.proofOfReserves ? (
                <p className="text-sm leading-relaxed">
                  {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                  {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}{" "}
                  <a
                    href={meta.proofOfReserves.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 py-2 text-frost-blue hover:underline sm:min-h-0 sm:py-0"
                  >
                    View reserves
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">No proof of reserves published</p>
              )}
            </div>

            <div
              id="jurisdiction"
              className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] lg:scroll-mt-6"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Jurisdiction
              </p>
              {meta.jurisdiction || meta.mica ? (
                <div className="flex flex-wrap items-center gap-2">
                  {meta.jurisdiction && <span className="text-sm font-medium">{meta.jurisdiction.country}</span>}
                  {meta.jurisdiction?.regulator && (
                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">
                      {meta.jurisdiction.regulator}
                    </span>
                  )}
                  {meta.jurisdiction?.license && (
                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20">
                      {meta.jurisdiction.license}
                    </span>
                  )}
                  {meta.mica && micaStatus && (
                    <ClassificationBadgeLink
                      href="/compliance/?regime=mica"
                      title={`${MICA_STATUS_DESCRIPTIONS[meta.mica.status]}${meta.status === "frozen" ? " Historical status retained for this frozen asset." : ""}`}
                      ariaLabel={`${micaBadgePrefix} status: ${micaStatus.label} — view the Compliance Tracker`}
                      cls={micaStatus.cls}
                    >
                      {micaBadgePrefix}: {micaStatus.label}
                    </ClassificationBadgeLink>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not disclosed</p>
              )}
            </div>
          </div>
        )}

        {/* Launch date — proof line for the hero passport's "Issued" field */}
        {launchDateDisplay && (
          <div className="border-t border-border/40 pt-3 sm:pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Launched</p>
            <p className="text-sm font-medium">{launchDateDisplay}</p>
          </div>
        )}

        {/* Contract Addresses */}
        {hasContracts && (
          <div
            id="contracts"
            className="scroll-mt-[calc(10rem+var(--pharos-sticky-summary-h,0px))] border-t border-border/40 pt-3 sm:pt-4 lg:scroll-mt-6"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              Contract Deployments
            </p>
            {contractSummary && <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{contractSummary}</p>}
            {quickCopyContract ? (
              <ContractDetailRow
                contract={quickCopyContract}
                copied={copiedContract === `${quickCopyContract.chain}:${quickCopyContract.address}`}
                label={openContract ? "Selected contract" : "Primary contract"}
                onCopy={copyContractAddress}
              />
            ) : null}
            <div className="grid grid-cols-5 gap-1.5 min-[360px]:grid-cols-6 sm:hidden">
              {visibleMobileContracts.map((c) => (
                <ContractChainButton
                  key={`${c.chain}-${c.address}`}
                  chainKey={c.chain}
                  address={c.address}
                  isOpen={openChain === c.chain}
                  onToggle={() => setOpenChain(openChain === c.chain ? null : c.chain)}
                />
              ))}
            </div>
            <div className="hidden sm:block">
              <div
                className={`grid grid-cols-1 gap-1.5 md:grid-cols-2 2xl:grid-cols-3 ${
                  showAllContractsDesktop ? "max-h-96 overflow-y-auto pr-1" : ""
                }`}
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
                    openChain &&
                    !mobileContractsPreview.some((c) => c.chain === openChain)
                  ) {
                    setOpenChain(null);
                  }
                  setShowAllContractsMobile((current) => !current);
                }}
                className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground sm:hidden"
              >
                {showAllContractsMobile ? "Show less" : `Show all ${contracts.length} chains`}
              </button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
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
            <Copy className={`pharos-copy-icon absolute h-4 w-4 ${copied ? "opacity-0" : "opacity-100"}`} aria-hidden="true" />
            <Check
              className={`pharos-copy-icon absolute h-4 w-4 text-emerald-500 ${copied ? "opacity-100" : "opacity-0"}`}
              aria-hidden="true"
            />
            {copied ? <span key={contract.chain} className="pharos-copy-ring" aria-hidden="true" /> : null}
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
 * two verification actions (copy, explorer) sit inline — recognition over
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
        <Copy className={`pharos-copy-icon absolute h-3.5 w-3.5 ${copied ? "opacity-0" : "opacity-100"}`} aria-hidden="true" />
        <Check
          className={`pharos-copy-icon absolute h-3.5 w-3.5 text-emerald-500 ${copied ? "opacity-100" : "opacity-0"}`}
          aria-hidden="true"
        />
        {copied ? <span key={contract.chain} className="pharos-copy-ring" aria-hidden="true" /> : null}
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
  const list = contracts ?? [];
  if (list.length === 0) return null;
  const chainNames = list.slice(0, 4).map((c) => CHAIN_META[c.chain]?.name ?? c.chain);
  const remaining = Math.max(list.length - chainNames.length, 0);
  const remainingSuffix = remaining > 0 ? `, plus ${remaining} more` : "";
  const formattedChains =
    chainNames.length <= 1
      ? (chainNames[0] ?? "")
      : chainNames.length === 2
        ? `${chainNames[0]} and ${chainNames[1]}`
        : `${chainNames.slice(0, -1).join(", ")}, and ${chainNames[chainNames.length - 1]}`;
  const deploymentLabel = list.length === 1 ? "deployment" : "deployments";
  return `${list.length} ${deploymentLabel} tracked across ${formattedChains}${remainingSuffix}.`;
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
        isOpen ? "ring-violet-500" : "ring-transparent hover:ring-muted-foreground/30"
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
