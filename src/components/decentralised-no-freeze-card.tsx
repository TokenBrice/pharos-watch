"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";

const VERIFIED_NO_FREEZE: ReadonlyArray<{ symbol: string; issuer: string; summary: string }> = [
  { symbol: "DAI", issuer: "MakerDAO", summary: "Immutable token contract; no per-address freeze." },
  { symbol: "LUSD", issuer: "Liquity", summary: "Immutable protocol; no administrator." },
  { symbol: "crvUSD", issuer: "Curve", summary: "No per-address freeze mechanism." },
  { symbol: "sDAI", issuer: "MakerDAO/Sky", summary: "ERC4626 wrapper; inherits DAI's immutability." },
  { symbol: "GHO", issuer: "Aave", summary: "Facilitator/bucket architecture; no per-address restriction." },
  { symbol: "USDe", issuer: "Ethena", summary: "Standard ERC20; no blacklist." },
  { symbol: "sUSDe", issuer: "Ethena", summary: "ERC4626 wrapper around USDe; inherits no freeze." },
  { symbol: "USDD", issuer: "Tron DAO Reserve", summary: "MakerDAO-style wards on Ethereum; no per-address freeze." },
];

export function DecentralisedNoFreezeCard() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <h3 className="text-sm font-semibold">No freeze possible</h3>
        <p className="text-xs text-muted-foreground">
          These stablecoins&apos; contracts emit no per-address blacklist, freeze, or seize events.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-1.5 text-xs">
          {VERIFIED_NO_FREEZE.map(({ symbol, issuer, summary }) => (
            <li key={symbol} className="flex items-baseline gap-1.5">
              <span className="font-medium shrink-0">{symbol}</span>
              <span className="text-muted-foreground truncate" title={`${issuer}: ${summary}`}>
                {summary}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
