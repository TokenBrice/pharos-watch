import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramLoopArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";
import { SYNTHETIC_DELTA_NEUTRAL_COPY } from "./mechanism-template";

const COPY = SYNTHETIC_DELTA_NEUTRAL_COPY["perp-short"];

interface SyntheticDeltaNeutralDiagramProps {
  symbol: string;
}

/** Generic hedged-synthetic diagram (`/learn`, OG images): the perp-short family copy. */
export function SyntheticDeltaNeutralDiagram({ symbol }: SyntheticDeltaNeutralDiagramProps) {
  const steps: MechanismDiagramStep[] = COPY.defaultSteps(symbol).map((step, index) => ({
    label: step.label,
    subtitle: step.subtitle,
    accentColor: COPY.accentColor,
    stepNumber: index + 1,
  }));

  return (
    <MechanismDiagramShell
      ariaLabel={COPY.ariaLabel(symbol)}
      description={COPY.description(symbol)}
      desktopHeight={120}
      steps={steps}
      stressFootnote={COPY.stressFootnote}
    >
      <DiagramStep
        x={0}
        label={steps[0].label}
        subtitle={steps[0].subtitle}
        stepNumber={1}
        accentColor={COPY.accentColor}
      />
      <DiagramArrow x={150} />
      <DiagramStep
        x={200}
        width={150}
        stepNumber={2}
        accentColor={COPY.accentColor}
      >
        <polygon
          points="34,20 42,20 38,13"
          fill="var(--severity-healthy)"
        />
        <text
          x={48}
          y={24}
          fontSize={11}
          fontWeight={600}
          fill="currentColor"
        >
          Long spot
        </text>
        <polygon
          points="34,42 42,42 38,49"
          fill="var(--severity-severe)"
        />
        <text
          x={48}
          y={47}
          fontSize={11}
          fontWeight={600}
          fill="currentColor"
        >
          Short perp
        </text>
      </DiagramStep>
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
        stepNumber={3}
        accentColor={COPY.accentColor}
      />
      <DiagramLoopArrow
        fromX={275}
        toX={500}
        baseY={30}
        peakY={6}
        label={COPY.loop?.label}
        labelY={9}
      />
    </MechanismDiagramShell>
  );
}
