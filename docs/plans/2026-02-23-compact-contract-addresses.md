# Compact Contract Addresses (Mobile) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the verbose per-chain row list with a compact icon strip on mobile, keeping the existing desktop layout unchanged.

**Architecture:** Responsive dual-view in `contract-addresses.tsx`. Mobile (`< md`): a row of 28px chain logo icons; tapping one opens an inline info panel below the strip showing chain name, truncated address, copy button, and explorer link. Desktop (`≥ md`): existing rows, no change.

**Tech Stack:** Next.js 16 static export, React 19 `useState`, `next/image`, Tailwind CSS v4 (md breakpoint = 768px), Lucide icons.

---

### Task 1: Download chain logo PNG files

**Files:**
- Create: `public/chains/ethereum.png`, `arbitrum.png`, `base.png`, `optimism.png`, `polygon.png`, `avalanche.png`, `bsc.png`, `gnosis.png`, `fantom.png`, `celo.png`, `tron.png`

**Step 1: Create the directory and run the download script**

```bash
mkdir -p public/chains

declare -A SLUGS=(
  [ethereum]="ethereum"
  [arbitrum]="arbitrum"
  [base]="base"
  [optimism]="optimism"
  [polygon]="polygon"
  [avalanche]="avax"
  [bsc]="bsc"
  [gnosis]="xdai"
  [fantom]="fantom"
  [celo]="celo"
  [tron]="tron"
)

for KEY in "${!SLUGS[@]}"; do
  SLUG="${SLUGS[$KEY]}"
  curl -sL "https://icons.llamao.fi/icons/chains/rsz_${SLUG}" -o "public/chains/${KEY}.png"
  echo "Downloaded ${KEY}.png"
done
```

**Step 2: Verify all 11 files downloaded and are non-empty**

```bash
ls -lh public/chains/
# Expected: 11 .png files, each > 1KB
```

> **Note:** If any file is 0 bytes or returns HTML, that slug is wrong. Check https://defillama.com — the chain slug in the URL is usually what DefiLlama uses. Common alternatives: `avax` vs `avalanche`, `xdai` vs `gnosis`, `bsc` vs `binance`.

**Step 3: Commit**

```bash
git add public/chains/
git commit -m "feat: add chain logo PNGs for contract address display"
```

---

### Task 2: Add `logoPath` to `ChainMeta`

**Files:**
- Modify: `src/lib/chains.ts`

**Step 1: Update the interface and add `logoPath` to every entry**

Replace the entire file content with:

```typescript
interface ChainMeta {
  name: string;
  explorerUrl: string;
  evmChainId: number | null;
  type: "evm" | "tron";
  logoPath: string;
}

export const CHAIN_META: Record<string, ChainMeta> = {
  ethereum:  { name: "Ethereum",  explorerUrl: "https://etherscan.io",              evmChainId: 1,     type: "evm",  logoPath: "/chains/ethereum.png"  },
  arbitrum:  { name: "Arbitrum",  explorerUrl: "https://arbiscan.io",               evmChainId: 42161, type: "evm",  logoPath: "/chains/arbitrum.png"  },
  base:      { name: "Base",      explorerUrl: "https://basescan.org",              evmChainId: 8453,  type: "evm",  logoPath: "/chains/base.png"      },
  optimism:  { name: "Optimism",  explorerUrl: "https://optimistic.etherscan.io",   evmChainId: 10,    type: "evm",  logoPath: "/chains/optimism.png"  },
  polygon:   { name: "Polygon",   explorerUrl: "https://polygonscan.com",           evmChainId: 137,   type: "evm",  logoPath: "/chains/polygon.png"   },
  avalanche: { name: "Avalanche", explorerUrl: "https://snowscan.xyz",              evmChainId: 43114, type: "evm",  logoPath: "/chains/avalanche.png" },
  bsc:       { name: "BSC",       explorerUrl: "https://bscscan.com",               evmChainId: 56,    type: "evm",  logoPath: "/chains/bsc.png"       },
  gnosis:    { name: "Gnosis",    explorerUrl: "https://gnosisscan.io",             evmChainId: 100,   type: "evm",  logoPath: "/chains/gnosis.png"    },
  fantom:    { name: "Fantom",    explorerUrl: "https://ftmscan.com",               evmChainId: 250,   type: "evm",  logoPath: "/chains/fantom.png"    },
  celo:      { name: "Celo",      explorerUrl: "https://celoscan.io",               evmChainId: 42220, type: "evm",  logoPath: "/chains/celo.png"      },
  tron:      { name: "Tron",      explorerUrl: "https://tronscan.org",              evmChainId: null,  type: "tron", logoPath: "/chains/tron.png"      },
};
```

**Step 2: Type-check**

```bash
npm run build 2>&1 | grep -E "error|Error" | head -20
# Expected: no type errors related to chains.ts
```

**Step 3: Commit**

```bash
git add src/lib/chains.ts
git commit -m "feat: add logoPath to ChainMeta for chain icon display"
```

---

### Task 3: Rewrite `contract-addresses.tsx` with responsive views

**Files:**
- Modify: `src/components/contract-addresses.tsx`

**Step 1: Replace the entire file with the responsive implementation**

```tsx
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
```

**Step 2: Build and type-check**

```bash
npm run build 2>&1 | tail -20
# Expected: compiled successfully, no type errors
```

If there are type errors, check:
- `"use client"` is the first line
- `useState` import is from `"react"`
- `Image` import is from `"next/image"`

**Step 3: Visually verify in dev server**

```bash
npm run dev
# Open http://localhost:3000/stablecoin/tether (USDT has 7 contracts — good test case)
# At < 768px width: should show 7 chain icons in a row
# Tap an icon: should show name + truncated address + copy + explorer link
# Tap same icon again: should collapse
# Tap different icon: should switch to that chain's info
# At ≥ 768px width: should show the original text row layout
```

**Step 4: Commit**

```bash
git add src/components/contract-addresses.tsx
git commit -m "feat: compact mobile icon strip for contract addresses"
```
