import { MethodologyFacts } from "../../methodology-shared";

export function LiquidityOverview() {
  return (
    <>
      <p>
        Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, updated every two hours. DEX-implied
        prices refresh hourly. The score aggregates
        pool data across all major DEXes and chains.
      </p>
      <p>
        Dead or explicitly blocked DEX slugs such as Bunni are excluded upstream from crawl intake, retained pools,
        challenger snapshots, and DEX-implied price publication instead of being treated as low-quality live venues.
      </p>
    </>
  );
}

export function LiquidityPreconditions() {
  return (
    <>
      <MethodologyFacts
        facts={[
          { label: "Update cadence", value: "Score: 2h; source stage and DEX-implied prices: hourly" },
          { label: "Signal mix", value: "5 weighted liquidity components" },
          { label: "Output", value: "0-100 DEX depth score" },
        ]}
      />
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
        <MethodologyFacts
          facts={[
            {
              label: "Minimum data",
              value: "No hard minimum in scorer; missing stability history defaults to neutral 50 sub-scores",
            },
            {
              label: "Required sources",
              value: "Pool TVL/volume/chain data plus mechanism and pair-quality metadata",
            },
            {
              label: "Failure behavior",
              value:
                "Standalone DEX rows can be unavailable. In V9 Exit, missing or unsupported comparable-route evidence receives the bounded floor and exit-unverified ceiling; a reviewed-complete portfolio with no viable route scores Exit 0.",
            },
          ]}
        />
      </div>
    </>
  );
}
