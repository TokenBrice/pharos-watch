import { VersionCard, getScoringEntry } from "./content-shared";

export function ScoringChangelogV728Entry() {
  return (
    <VersionCard entry={getScoringEntry("7.28")} accent="border-l-orange-500">
      <p>FreezeWatch re-audits the active assets that still resolved as No after the Dilutable retirement.</p>
      <ul className="list-disc list-inside space-y-1">
        <li>M by M0, ISC, and USG now resolve as direct Yes.</li>
        <li>DLLR, FXD, CJPY, USDQ, and USDK now resolve as Possible.</li>
        <li>JUSD, SILK, NXUSD, LUAUSD, KRWO, and BNUSD now resolve as Upstream.</li>
      </ul>
    </VersionCard>
  );
}
