import type { DiagramTone, MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramReturnArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

export interface MechanismStepText {
  label: string;
  subtitle?: string;
}

export interface MechanismStepOverride {
  label?: string;
  subtitle?: string;
}

interface ThreeStepReturnArrow {
  fromX: number;
  toX: number;
  topY: number;
  peakY: number;
  label: string;
  tone?: Extract<DiagramTone, "default" | "danger">;
  dashed?: boolean;
  strokeWidth?: number;
}

interface ThreeStepMechanismDiagramProps {
  ariaLabel: string;
  description: string;
  accentColor: string;
  defaultSteps: readonly [MechanismStepText, MechanismStepText, MechanismStepText];
  overrideSteps?: ReadonlyArray<MechanismStepOverride>;
  stressFootnote?: string;
  returnArrow: ThreeStepReturnArrow;
}

function buildSteps(
  defaults: readonly [MechanismStepText, MechanismStepText, MechanismStepText],
  overrides: ReadonlyArray<MechanismStepOverride> | undefined,
  accentColor: string,
): MechanismDiagramStep[] {
  return defaults.map((step, index) => ({
    label: overrides?.[index]?.label ?? step.label,
    subtitle: overrides?.[index]?.subtitle ?? step.subtitle,
    accentColor,
    stepNumber: index + 1,
  }));
}

export function ThreeStepMechanismDiagram({
  ariaLabel,
  description,
  accentColor,
  defaultSteps,
  overrideSteps,
  stressFootnote,
  returnArrow,
}: ThreeStepMechanismDiagramProps) {
  const steps = buildSteps(defaultSteps, overrideSteps, accentColor);

  return (
    <MechanismDiagramShell
      ariaLabel={ariaLabel}
      description={description}
      desktopHeight={155}
      steps={steps}
      stressFootnote={stressFootnote}
    >
      <DiagramStep
        x={0}
        label={steps[0].label}
        subtitle={steps[0].subtitle}
        stepNumber={1}
        accentColor={accentColor}
      />
      <DiagramArrow x={150} />
      <DiagramStep
        x={200}
        label={steps[1].label}
        subtitle={steps[1].subtitle}
        stepNumber={2}
        accentColor={accentColor}
      />
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
        stepNumber={3}
        accentColor={accentColor}
      />
      <DiagramReturnArrow {...returnArrow} />
    </MechanismDiagramShell>
  );
}
