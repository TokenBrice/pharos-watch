import Link from "next/link";
import { SAFETY_SCORES_SECTION_CONTENT } from "@/lib/methodology-content";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologyPreconditions,
} from "../../methodology-shared";

export function SafetyScoresOverview() {
  const { markdownParagraphs, historyLinks } = SAFETY_SCORES_SECTION_CONTENT;

  return (
    <>
      <p>{markdownParagraphs[0]}</p>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <Link href="/methodology/scoring-changelog/" className={METHODOLOGY_LINK_CLASS}>Safety Score changelog</Link>
        {" · "}
        <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>PegScore + DEWS</a>
        {" · "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
        {" · "}
        <a href="#infrastructure-methodology" className={METHODOLOGY_LINK_CLASS}>Infrastructure</a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "Model shape", value: "3 pillars + bounded aggregation" },
          { label: "Grade output", value: "A+ to F; NR and Pipeline gap are distinct" },
          { label: "Publication state", value: "Current or held; never V8 fallback" },
        ]}
      />
      <MethodologyPreconditions
        facts={[
          { label: "Minimum data", value: "At least two included pillars for a score; scoped cause proof for exclusions" },
          { label: "Required sources", value: "Backing, exit, control, peg, dependency, and evidence-provenance inputs" },
          {
            label: "Failure behavior",
            value: "Technical gaps have no score/grade; NR needs causal evidence gates; global failures hold accepted state",
          },
        ]}
      />
      <MethodologyDetails summary="Current evidence rules and admission constraints">
        {markdownParagraphs.slice(1).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </MethodologyDetails>
      <MethodologyDetails summary="Canonical release evidence and replay history">
        <p>Release chronology, calibration examples and replay results belong to the structured scoring history.</p>
        <ul className="list-disc list-inside space-y-1">
          {historyLinks.map(({ label, href }) => (
            <li key={href}><Link href={href} className={METHODOLOGY_LINK_CLASS}>{label}</Link></li>
          ))}
        </ul>
      </MethodologyDetails>
    </>
  );
}
