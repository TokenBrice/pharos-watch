"use client";

import { useState } from "react";
import Image from "next/image";
import { Copy, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHAIN_META } from "@/lib/chains";
import type { StablecoinMeta } from "@/lib/types";

function getExplorerUrl(chainKey: string, address: string): string {
  const chain = CHAIN_META[chainKey];
  return chainKey === "tron"
    ? `${chain?.explorerUrl}/#/contract/${address}`
    : `${chain?.explorerUrl}/address/${address}`;
}

export function ContractAddresses({ meta }: { meta: StablecoinMeta }) {
  const [openChain, setOpenChain] = useState<string | null>(null);

  if (!meta.contracts || meta.contracts.length === 0) return null;

  const openContract = meta.contracts.find((c) => c.chain === openChain) ?? null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Contract Addresses
        </CardTitle>
      </CardHeader>
      <CardContent>

        {/* ── Mobile: icon strip ──────────────────────────────── */}
        <div className="md:hidden">
          <div className="flex flex-wrap gap-2">
            {meta.contracts.map((c) => {
              const chain = CHAIN_META[c.chain];
              const isOpen = openChain === c.chain;
              return (
                <button
                  key={`${c.chain}-${c.address}`}
                  onClick={() => setOpenChain(isOpen ? null : c.chain)}
                  className={`rounded-full ring-2 transition-colors ${
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
                      className="rounded-full"
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
              <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 space-y-1.5">
                <div className="text-sm font-medium">{chain?.name ?? openContract.chain}</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground truncate">
                    {openContract.address.slice(0, 6)}...{openContract.address.slice(-4)}
                  </span>
                  <button
                    onClick={() => navigator.clipboard.writeText(openContract.address)}
                    className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                    title="Copy address"
                    aria-label="Copy address"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline"
                >
                  View on {chain?.name ? `${chain.name} explorer` : "explorer"}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            );
          })()}
        </div>

        {/* ── Desktop: existing text rows ─────────────────────── */}
        <div className="hidden md:block space-y-2">
          {meta.contracts.map((c) => {
            const chain = CHAIN_META[c.chain];
            const explorerUrl = getExplorerUrl(c.chain, c.address);
            return (
              <div key={`${c.chain}-${c.address}`} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-sm font-medium text-muted-foreground">{chain?.name ?? c.chain}</span>
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-blue-500 hover:underline"
                >
                  {c.address.slice(0, 6)}...{c.address.slice(-4)}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            );
          })}
        </div>

      </CardContent>
    </Card>
  );
}
