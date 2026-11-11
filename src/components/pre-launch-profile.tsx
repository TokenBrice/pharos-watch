import Link from "next/link";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import { BACKING_LABELS, GOVERNANCE_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";
import { getLogoSrc, logosById } from "@/lib/logos";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";

function chainName(chain: string): string {
  return CHAIN_META[chain]?.name ?? chain;
}

export function PlannedProfileCard({ coin }: { coin: StablecoinMeta }) {
  const launched = isLaunchedAwaitingData(coin);
  const chains = [...new Set(coin.contracts?.map((c) => c.chain) ?? [])].map(chainName);
  const jurisdiction = coin.jurisdiction?.regulator
    ? `${coin.jurisdiction.country} (${coin.jurisdiction.regulator})`
    : coin.jurisdiction?.country;
  const facts: FactGridItem[] = [
    { key: "peg", label: "Peg", value: PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency, valueStyle: "text" },
    { key: "backing", label: "Backing", value: BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing, valueStyle: "text" },
    { key: "governance", label: "Governance", value: GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance, valueStyle: "text" },
    { key: "jurisdiction", label: "Jurisdiction", value: jurisdiction ?? "Not recorded", valueStyle: "text" },
    ...(coin.flags.yieldBearing ? [{ key: "yield", label: "Yield", value: "Yield-bearing", valueStyle: "text" as const }] : []),
    ...(chains.length > 0 ? [{ key: "chains", label: launched ? "Chains" : "Target chains", value: chains.join(", "), valueStyle: "text" as const }] : []),
  ];
  const title = launched ? "Profile" : "Planned profile";

  return (
    <RailCard title={title} ariaLabel={title}>
      <div className="space-y-4 px-4 pb-4">
        <FactGrid items={facts} aria-label={title} />
        {coin.reserves && coin.reserves.length > 0 ? (
          <div className="space-y-2 border-t border-border/50 pt-3">
            <p className="pharos-label">{launched ? "Stated collateral" : "Planned collateral"}</p>
            <ul className="space-y-1.5">
              {coin.reserves.map((slice) => (
                <li key={slice.name} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 break-words text-foreground">{slice.name}</span>
                  <span className="pharos-numeric shrink-0 text-muted-foreground">{slice.pct}%</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </RailCard>
  );
}

/**
 * Active and pre-launch coins: the existing same-currency sort then ranks the
 * coin's upcoming siblings (other HKD/JPY/KRW launches) ahead of USD majors.
 */
const RELATED_CANDIDATES = CLIENT_TRACKED_STABLECOINS.filter(
  (candidate) => isActiveStablecoinMeta(candidate) || isPreLaunchStablecoinMeta(candidate),
);

export function RelatedCard({ coin }: { coin: StablecoinMeta }) {
  const related = getRelatedStablecoins(coin, { candidates: RELATED_CANDIDATES });
  return (
    <RailCard title="Related stablecoins" ariaLabel="Related stablecoins">
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          {related.length > 0
            ? "Tracked stablecoins with a similar governance, backing or peg profile."
            : "No tracked stablecoin shares this profile yet."}
        </p>
        {related.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {related.map((rel) => (
              <Link
                key={rel.id}
                href={buildStablecoinUrl(rel.id)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent lg:min-h-9"
              >
                <StablecoinLogo src={getLogoSrc(logosById, rel.id)} name={rel.name} size={18} />
                <span className="font-mono text-xs font-medium tabular-nums">{rel.symbol}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </RailCard>
  );
}
