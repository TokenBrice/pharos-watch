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
  returnArrow?: ThreeStepReturnArrow;
  stepTone?: DiagramTone;
  dashed?: boolean;
}

function buildSteps(
  defaults: readonly [MechanismStepText, MechanismStepText, MechanismStepText],
  overrides: ReadonlyArray<MechanismStepOverride> | undefined,
  accentColor: string,
  dashed: boolean,
): MechanismDiagramStep[] {
  return defaults.map((step, index) => ({
    label: overrides?.[index]?.label ?? step.label,
    subtitle: overrides?.[index]?.subtitle ?? step.subtitle,
    accentColor,
    stepNumber: index + 1,
    dashedBorder: dashed ? true : undefined,
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
  stepTone = "default",
  dashed = false,
}: ThreeStepMechanismDiagramProps) {
  const steps = buildSteps(defaultSteps, overrideSteps, accentColor, dashed);

  return (
    <MechanismDiagramShell
      ariaLabel={ariaLabel}
      description={description}
      desktopHeight={returnArrow ? 155 : undefined}
      steps={steps}
      stressFootnote={stressFootnote}
    >
      <DiagramStep
        x={0}
        label={steps[0].label}
        subtitle={steps[0].subtitle}
        stepNumber={1}
        accentColor={accentColor}
        dashedBorder={dashed}
        tone={stepTone}
      />
      <DiagramArrow x={150} dashed={dashed} />
      <DiagramStep
        x={200}
        label={steps[1].label}
        subtitle={steps[1].subtitle}
        stepNumber={2}
        accentColor={accentColor}
        dashedBorder={dashed}
        tone={stepTone}
      />
      <DiagramArrow x={350} dashed={dashed} />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
        stepNumber={3}
        accentColor={accentColor}
        dashedBorder={dashed}
        tone={stepTone}
      />
      {returnArrow ? <DiagramReturnArrow {...returnArrow} /> : null}
    </MechanismDiagramShell>
  );
}
