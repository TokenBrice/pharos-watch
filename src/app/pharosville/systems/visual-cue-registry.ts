import type { VisualCue } from "./world-types";

export function buildVisualCueRegistry(): VisualCue[] {
  return [
    {
      id: "cue.lighthouse.psi",
      visual: "lighthouse flame and beam",
      sourceField: "stability.current.band",
      questionAnswered: "What is the overall Pharos Stability Index state?",
      failureState: "unlit/fogged lighthouse",
      domEquivalent: "lighthouse detail panel",
    },
    {
      id: "cue.dock.size",
      visual: "dock footprint",
      sourceField: "chains.chains[].totalUsd",
      questionAnswered: "Which chains hold the largest stablecoin supply?",
      failureState: "dock unavailable state",
      domEquivalent: "dock ledger rows",
    },
    {
      id: "cue.ship.distance",
      visual: "ship placement from harbor to storm shelf",
      sourceField: "pegSummary.coins[], stress.signals[]",
      questionAnswered: "Which stablecoins are under peg or DEWS stress?",
      failureState: "data fog",
      domEquivalent: "ship detail placement explanation",
    },
    {
      id: "cue.ship.hull",
      visual: "ship class silhouette",
      sourceField: "stablecoinMeta.flags.governance",
      questionAnswered: "Is the stablecoin CeFi, CeFi-dependent, or DeFi?",
      failureState: "generic hull",
      domEquivalent: "ship detail class row",
    },
    {
      id: "cue.ship.rigging",
      visual: "ship rigging style",
      sourceField: "stablecoinMeta.flags.governance",
      questionAnswered: "Which governance class controls the base ship model?",
      failureState: "generic rigging",
      domEquivalent: "ship detail class row",
    },
    {
      id: "cue.ship.pennant",
      visual: "ship pennant color",
      sourceField: "stablecoinMeta.flags.pegCurrency",
      questionAnswered: "What is the peg currency?",
      failureState: "slate pennant",
      domEquivalent: "ship detail peg row",
    },
    {
      id: "cue.ship.scale",
      visual: "compressed ship scale tier",
      sourceField: "stablecoins.peggedAssets[].circulating",
      questionAnswered: "Roughly how large is the stablecoin supply without letting outliers dominate the map?",
      failureState: "small default scale",
      domEquivalent: "ship detail market-cap and size-tier rows",
    },
    {
      id: "cue.cemetery",
      visual: "cemetery graves",
      sourceField: "CEMETERY_ENTRIES",
      questionAnswered: "Which assets are dead or frozen?",
      failureState: "cemetery unavailable row",
      domEquivalent: "cemetery ledger rows",
    },
  ];
}
