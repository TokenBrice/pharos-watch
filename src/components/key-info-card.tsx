"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Copy, ExternalLink, Globe } from "lucide-react";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CHAIN_META } from "@shared/lib/chains";
import { getInfrastructureLabel, getInfrastructureSummary } from "@shared/lib/infrastructure";
import { formatAddress } from "@shared/lib/format";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { trackEvent } from "@/lib/analytics";
import type { StablecoinMeta } from "@shared/types";
import {
  BACKING_BADGE_STYLES,
  BACKING_LABELS,
  GOVERNANCE_BADGE_STYLES,
  GOVERNANCE_LABELS,
  PEG_BADGE_STYLES,
  PEG_LABELS,
  POR_BADGE_STYLES,
} from "@shared/lib/classification";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import {
  buildBackingTaxonomyUrl,
  buildGovernanceTaxonomyUrl,
  buildInfrastructureTaxonomyUrl,
} from "@/lib/stablecoin-taxonomy";

export function KeyInfoCard({ meta }: { meta: StablecoinMeta }) {
  const [openChain, setOpenChain] = useState<string | null>(null);
  const [showAllContractsMobile, setShowAllContractsMobile] = useState(false);
  const [copiedChain, setCopiedChain] = useState<string | null>(null);
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
  const hasDescription = meta.collateral || meta.pegMechanism;
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasLinks = meta.links && meta.links.length > 0;
  const hasContracts = contracts.length > 0;
  const contractSummary = buildContractDeploymentSummary(contracts);
  const mobileContractsPreview = contracts.slice(0, 6);
  const visibleMobileContracts = showAllContractsMobile ? contracts : mobileContractsPreview;
  const hiddenMobileContractCount = Math.max(contracts.length - mobileContractsPreview.length, 0);

  const openContract = hasContracts ? (contracts.find((c) => c.chain === openChain) ?? null) : null;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-2">
        <DetailSectionTitle>
          Key Information
        </DetailSectionTitle>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {meta.name} ({meta.symbol}) is a {governanceFullLabel}, {backingFullLabel} stablecoin pegged to{" "}
          {pegFullLabel}.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 sm:space-y-4">
        {/* Classification badges (identity) then external links (navigation) */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {gov && (
              <Link
                href={governanceHref}
                aria-label={`Browse ${governanceFullLabel} stablecoins`}
                className={`pharos-focus-ring inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors hover:brightness-110 ${gov.cls}`}
              >
                {gov.label}
              </Link>
            )}
            {backing && (
              <Link
                href={backingHref}
                aria-label={`Browse ${backingFullLabel} stablecoins`}
                className={`pharos-focus-ring inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors hover:brightness-110 ${backing.cls}`}
              >
                {backing.label}
              </Link>
            )}
            {peg &&
              (pegHref ? (
                <Link
                  href={pegHref}
                  aria-label={`Browse ${pegFullLabel} stablecoins`}
                  className={`pharos-focus-ring inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors hover:brightness-110 ${peg.cls}`}
                >
                  {peg.label}
                </Link>
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
                <span
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${POR_BADGE_STYLES[meta.proofOfReserves.type].cls}`}
                >
                  {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                </span>
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

        {/* Collateral + Peg Stability */}
        {hasDescription && (
          <div className="grid gap-x-6 gap-y-3 border-t border-border/40 pt-3 sm:pt-4 sm:grid-cols-2">
            {meta.collateral && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Collateral</p>
                <p className="text-base leading-relaxed">{meta.collateral}</p>
              </div>
            )}
            {meta.pegMechanism && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Peg Stability
                </p>
                <p className="text-base leading-relaxed">{meta.pegMechanism}</p>
              </div>
            )}
          </div>
        )}

        {infrastructureSummaries.length > 0 && (
          <div className="border-t border-border/40 pt-3 sm:pt-4 space-y-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Infrastructure</p>
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
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Proof of Reserves
              </p>
              {meta.proofOfReserves ? (
                <p className="text-sm leading-relaxed">
                  {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                  {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}
                  {" "}
                  <a
                    href={meta.proofOfReserves.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pharos-focus-ring inline-flex items-center gap-1 text-frost-blue hover:underline"
                  >
                    View reserves<ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">No proof of reserves published</p>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Jurisdiction
              </p>
              {meta.jurisdiction ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{meta.jurisdiction.country}</span>
                  {meta.jurisdiction.regulator && (
                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20">
                      {meta.jurisdiction.regulator}
                    </span>
                  )}
                  {meta.jurisdiction.license && (
                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20">
                      {meta.jurisdiction.license}
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not disclosed</p>
              )}
            </div>
          </div>
        )}

        {/* Contract Addresses */}
        {hasContracts && (
          <div className="border-t border-border/40 pt-3 sm:pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              Contract Deployments
            </p>
            {contractSummary && (
              <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{contractSummary}</p>
            )}
            <div className="grid grid-cols-6 gap-2 sm:hidden">
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
            <div className="hidden flex-wrap gap-2 sm:flex">
              {contracts.map((c) => (
                <ContractChainButton
                  key={`${c.chain}-${c.address}`}
                  chainKey={c.chain}
                  address={c.address}
                  isOpen={openChain === c.chain}
                  onToggle={() => setOpenChain(openChain === c.chain ? null : c.chain)}
                />
              ))}
            </div>
            {hiddenMobileContractCount > 0 ? (
              <button
                onClick={() => {
                  if (showAllContractsMobile && openChain && !mobileContractsPreview.some((c) => c.chain === openChain)) {
                    setOpenChain(null);
                  }
                  setShowAllContractsMobile((current) => !current);
                }}
                className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground sm:hidden"
              >
                {showAllContractsMobile ? "Show less" : `Show all ${contracts.length} chains`}
              </button>
            ) : null}
            {openContract &&
              (() => {
                const chain = CHAIN_META[openContract.chain];
                const explorerUrl = buildExplorerUrl({
                  chainKey: openContract.chain,
                  entityType: "contract",
                  value: openContract.address,
                });
                return (
                  <div className="mt-3 rounded-lg border border-border/40 bg-background/60 px-3 py-2 space-y-1.5">
                    <div className="text-sm font-medium">
                      <Link href={`/chains/${openContract.chain}/`} className="pharos-focus-ring rounded-sm hover:underline">
                        {chain?.name ?? openContract.chain}
                      </Link>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground truncate">
                        {formatAddress(openContract.address)}
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(openContract.address);
                          trackEvent("contract_copied", { coin_id: meta.id, chain: openContract.chain });
                          setCopiedChain(openContract.chain);
                          setTimeout(() => setCopiedChain(null), 2000);
                        }}
                        className="pharos-focus-ring inline-flex size-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                        title="Copy address"
                        aria-label="Copy address"
                      >
                        {copiedChain === openContract.chain ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                    {explorerUrl && (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-md text-xs text-frost-blue hover:underline"
                      >
                        View on {chain?.name ? `${chain.name} explorer` : "explorer"}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                );
              })()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function buildContractDeploymentSummary(contracts: StablecoinMeta["contracts"]): string | null {
  const list = contracts ?? [];
  if (list.length === 0) return null;
  const chainNames = list.slice(0, 4).map((c) => CHAIN_META[c.chain]?.name ?? c.chain);
  const remaining = Math.max(list.length - chainNames.length, 0);
  const remainingSuffix = remaining > 0 ? `, plus ${remaining} more` : "";
  const formattedChains =
    chainNames.length <= 1
      ? chainNames[0] ?? ""
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
