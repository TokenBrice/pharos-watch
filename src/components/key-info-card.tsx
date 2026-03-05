"use client";

import { useState } from "react";
import Image from "next/image";
import { Copy, ExternalLink, Globe } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHAIN_META } from "@shared/lib/chains";
import { trackEvent } from "@/lib/analytics";
import type { StablecoinMeta } from "@shared/types";
import {
  GOVERNANCE_BADGE_STYLES,
  BACKING_BADGE_STYLES,
  PEG_BADGE_STYLES,
  POR_BADGE_STYLES,
} from "@shared/lib/classification";

function getExplorerUrl(chainKey: string, address: string): string | null {
  const chain = CHAIN_META[chainKey];
  if (!chain?.explorerUrl) return null;
  return chainKey === "tron"
    ? `${chain.explorerUrl}/#/contract/${address}`
    : `${chain.explorerUrl}/address/${address}`;
}

export function KeyInfoCard({ meta }: { meta: StablecoinMeta }) {
  const [openChain, setOpenChain] = useState<string | null>(null);

  const gov = GOVERNANCE_BADGE_STYLES[meta.flags.governance];
  const backing = BACKING_BADGE_STYLES[meta.flags.backing];
  const peg = PEG_BADGE_STYLES[meta.flags.pegCurrency];
  const hasDescription = meta.collateral || meta.pegMechanism;
  const isDecentralized = meta.flags.governance === "decentralized";
  const hasLinks = meta.links && meta.links.length > 0;
  const hasContracts = meta.contracts && meta.contracts.length > 0;

  const openContract = hasContracts
    ? (meta.contracts!.find((c) => c.chain === openChain) ?? null)
    : null;

  return (
    <Card className="rounded-xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Key Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Links (left) + classification badges (right) */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {hasLinks && (
            <div className="flex flex-wrap items-center gap-2">
              {meta.links?.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
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
          <div className="flex flex-wrap items-center gap-2">
            {gov && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${gov.cls}`}>{gov.label}</span>}
            {backing && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${backing.cls}`}>{backing.label}</span>}
            {peg && <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${peg.cls}`}>{peg.label}</span>}
            {meta.flags.yieldBearing && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Yield-Bearing</span>}
            {meta.flags.rwa && <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-sky-500/10 text-sky-500 border-sky-500/20">RWA</span>}
            {!isDecentralized && (
              meta.proofOfReserves ? (
                <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${POR_BADGE_STYLES[meta.proofOfReserves.type].cls}`}>
                  {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-red-500/10 text-red-500 border-red-500/20">
                  No PoR
                </span>
              )
            )}
          </div>
        </div>

        {/* Collateral + Peg Stability */}
        {hasDescription && (
          <div className="grid gap-4 sm:grid-cols-2">
            {meta.collateral && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Collateral</p>
                <p className="text-sm leading-relaxed">{meta.collateral}</p>
              </div>
            )}
            {meta.pegMechanism && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Peg Stability</p>
                <p className="text-sm leading-relaxed">{meta.pegMechanism}</p>
              </div>
            )}
          </div>
        )}

        {/* Proof of Reserves + Jurisdiction (2-col on desktop) */}
        {!isDecentralized && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl bg-muted/50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Proof of Reserves</p>
              {meta.proofOfReserves ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm leading-relaxed">
                    {POR_BADGE_STYLES[meta.proofOfReserves.type].label}
                    {meta.proofOfReserves.provider && ` by ${meta.proofOfReserves.provider}`}
                  </p>
                  <a
                    href={meta.proofOfReserves.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-500 hover:underline shrink-0"
                  >
                    View reserves <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No proof of reserves published</p>
              )}
            </div>

            {meta.jurisdiction && (
              <div className="rounded-xl bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Jurisdiction</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{meta.jurisdiction.country}</span>
                  {meta.jurisdiction.regulator && (
                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-blue-500/10 text-blue-500 border-blue-500/20">
                      {meta.jurisdiction.regulator}
                    </span>
                  )}
                  {meta.jurisdiction.license && (
                    <span className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold bg-violet-500/10 text-violet-500 border-violet-500/20">
                      {meta.jurisdiction.license}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Contract Addresses */}
        {hasContracts && (
          <div className="rounded-xl bg-muted/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Contract Addresses</p>
            <div className="flex flex-wrap gap-2">
              {meta.contracts!.map((c) => {
                const chain = CHAIN_META[c.chain];
                const isOpen = openChain === c.chain;
                return (
                  <button
                    key={`${c.chain}-${c.address}`}
                    onClick={() => setOpenChain(isOpen ? null : c.chain)}
                    className={`rounded-full ring-2 transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                      isOpen ? "ring-violet-500" : "ring-transparent hover:ring-muted-foreground/30"
                    }`}
                    title={chain?.name ?? c.chain}
                    aria-label={`${chain?.name ?? c.chain} contract`}
                  >
                    {chain?.logoPath ? (
                      <Image
                        src={chain.logoPath}
                        alt={chain.name}
                        width={28}
                        height={28}
                        className={`rounded-full${chain.darkInvert ? " dark:invert" : ""}`}
                      />
                    ) : (
                      <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                        {(chain?.name ?? c.chain).charAt(0).toUpperCase()}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {openContract && (() => {
              const chain = CHAIN_META[openContract.chain];
              const explorerUrl = getExplorerUrl(openContract.chain, openContract.address);
              return (
                <div className="mt-3 rounded-lg bg-background/60 px-3 py-2 space-y-1.5">
                  <div className="text-sm font-medium">{chain?.name ?? openContract.chain}</div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground truncate">
                      {openContract.address.slice(0, 6)}...{openContract.address.slice(-4)}
                    </span>
                    <button
                      onClick={() => { navigator.clipboard.writeText(openContract.address); trackEvent("contract_copied", { coin_id: meta.id, chain: openContract.chain }); }}
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      title="Copy address"
                      aria-label="Copy address"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {explorerUrl && (
                    <a
                      href={explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline"
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
