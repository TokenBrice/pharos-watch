import Link from "next/link";
import { DEPENDENCY_EXPOSURE_SECTION_CONTENT } from "@/lib/methodology-content";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
} from "../methodology-shared";

export function DependencyExposureMethodologySection() {
  const { id, title, markdownParagraphs } = DEPENDENCY_EXPOSURE_SECTION_CONTENT;

  return (
    <MethodologySectionShell id={id} title={title}>
      <p>
        Exposure mode on the{" "}
        <Link href="/dependency-map/?mode=exposure" className={METHODOLOGY_LINK_CLASS}>
          Dependency Map
        </Link>
        {" "}finds coins linked to selected upstream assets through mapped collateral and wrapper
        relationships. Linked coins; not a loss forecast. It does not estimate losses or changes
        in Safety Scores.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Inputs", value: "Selected upstream roots and the full published dependency graph" },
          { label: "Output", value: "Mapped dependent counts, look-through shares, and known USD" },
          { label: "Supply basis", value: "Circulating USD at publication evaluation, never current market cap" },
        ]}
      />
      <p>{markdownParagraphs[1]}</p>
      <MethodologyDetails summary="Lookup arithmetic, supply clocks, and limitations">
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Serial maximum and basket sum</h3>
          <p>{markdownParagraphs[2]}</p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Publication-bound supply</h3>
          <p>{markdownParagraphs[3]}</p>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Coverage and limitations</h3>
          <p>{markdownParagraphs[4]}</p>
          <Link href="/coverage/" className={METHODOLOGY_LINK_CLASS}>
            Review coverage gaps
          </Link>
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Separate offline modeled scenarios</h3>
          <p>{markdownParagraphs[6]}</p>
        </div>
      </MethodologyDetails>
      <MethodologyDetails summary="History examples">
        <p>
          These case studies explain past events. They are links only, not runnable presets or
          a historical replay.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <Link href="/learn/case-studies/usdx-kava-2022/" className={METHODOLOGY_LINK_CLASS}>
              Kava USDX and UST collateral
            </Link>
          </li>
          <li>
            <Link href="/learn/case-studies/ftx-contagion-2022/" className={METHODOLOGY_LINK_CLASS}>
              FTX and market-liquidity transmission beyond backing links
            </Link>
          </li>
        </ul>
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
