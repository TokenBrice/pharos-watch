import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-04-27", to: "2026-05-03" },
  headline:
    "BUCK moves to the cemetery while admin stress signals stop flagging stale probe and remediation paths.",
  summary: [
    {
      label: "BUCK frozen",
      tag: "coverage",
      description:
        "BUCK is archived as a frozen cemetery entry after the project shutdown notice replaced live issuer disclosures; active mint/burn, yield, reserve, and redemption hooks no longer monitor it.",
    },
    {
      label: "Admin stress cleanup",
      tag: "infra",
      description:
        "Operator probes now call status-probe-history with a valid target path, blacklist gap remediation backfills stale amount rows by default, and the dead BUCK live-reserve breaker is removed.",
    },
  ],
  stats: { totalCommits: 2 },
  commits: [
    { hash: "ad6398aba", message: "feat(stablecoin): freeze BUCK" },
    { hash: "9def4e4c9", message: "fix admin stress signals" },
  ],
};
