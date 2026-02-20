import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHAIN_META } from "@/lib/chains";
import type { StablecoinMeta } from "@/lib/types";

export function ContractAddresses({ meta }: { meta: StablecoinMeta }) {
  if (!meta.contracts || meta.contracts.length === 0) return null;

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contract Addresses</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {meta.contracts.map((c) => {
            const chain = CHAIN_META[c.chain];
            const addressUrl = c.chain === "tron"
              ? `${chain?.explorerUrl}/#/contract/${c.address}`
              : `${chain?.explorerUrl}/address/${c.address}`;

            return (
              <div key={`${c.chain}-${c.address}`} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                <span className="text-sm font-medium text-muted-foreground">{chain?.name ?? c.chain}</span>
                <a
                  href={addressUrl}
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
