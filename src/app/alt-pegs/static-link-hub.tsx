import Link from "next/link";
import { buildAltPegLinkHubGroups } from "@/lib/alt-peg-market";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();
const FIAT_REGION_ORDER = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"] as const;

function LinkChip({
  href,
  label,
  coinCount,
  symbolPreview,
  colorHex,
}: {
  href: string;
  label: string;
  coinCount: number;
  symbolPreview: string;
  colorHex: string;
}) {
  return (
    <Link
      href={href}
      className="pharos-focus-ring inline-flex min-h-11 flex-col rounded-xl border border-border/70 bg-background/55 px-3 py-2 text-left shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/65 hover:text-foreground"
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: colorHex }}
        />
        {label}
      </span>
      <span className="mt-1 text-xs text-muted-foreground">
        {coinCount} coin{coinCount === 1 ? "" : "s"}
        {symbolPreview ? ` · ${symbolPreview}` : ""}
      </span>
    </Link>
  );
}

export function StaticAltPegLinkHub() {
  const fiatGroup = LINK_HUB_GROUPS.find((group) => group.label === "Fiat") ?? null;
  const sideGroups = LINK_HUB_GROUPS.filter((group) => group.label !== "Fiat");
  const fiatRegions = FIAT_REGION_ORDER.map((region) => ({
    region,
    items: fiatGroup?.items.filter((item) => item.region === region) ?? [],
  })).filter((region) => region.items.length > 0);

  return (
    <section aria-labelledby="alt-peg-link-hub" className="space-y-3">
      <div className="space-y-1">
        <p className="pharos-kicker">Drill Down</p>
        <h2 id="alt-peg-link-hub" className="pharos-section-title">
          Explore Peg Cohorts
        </h2>
        <p className="pharos-meta">
          Static route links keep the non-USD cohort taxonomy crawlable and make it easy to jump from the market lens
          into the peg you want to inspect next.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,0.85fr)]">
        {fiatGroup ? (
          <section className="pharos-card-shell space-y-4 p-4 sm:p-5">
            <div className="space-y-1">
              <p className="pharos-kicker">Fiat</p>
              <p className="text-sm text-muted-foreground">
                Currency-linked stablecoin cohorts outside the dollar, grouped by region so the big non-USD surface is
                easier to scan.
              </p>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {fiatRegions.map((region) => (
                <section key={region.region} className="space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                    {region.region}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {region.items.map((item) => (
                      <LinkChip
                        key={item.href}
                        href={item.href}
                        label={item.label}
                        coinCount={item.coinCount}
                        symbolPreview={item.symbolPreview}
                        colorHex={item.colorHex}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </section>
        ) : null}

        <div className="grid gap-4">
          {sideGroups.map((group) => (
            <section key={group.label} className="pharos-card-shell space-y-3 p-4 sm:p-5">
              <div className="space-y-1">
                <p className="pharos-kicker">{group.label}</p>
                <p className="text-sm text-muted-foreground">
                  {group.label === "Commodity"
                    ? "Metal-backed stablecoin cohorts tracked as alternative pegs."
                    : "Inflation-linked and other non-USD peg structures."}
                </p>
              </div>

              <div className="grid gap-2">
                {group.items.map((item) => (
                  <LinkChip
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    coinCount={item.coinCount}
                    symbolPreview={item.symbolPreview}
                    colorHex={item.colorHex}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
