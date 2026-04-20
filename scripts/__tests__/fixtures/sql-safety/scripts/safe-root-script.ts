export function safeRootScriptValueInterpolation(pegType: string) {
  const allowedPegTypes = new Set(["peggedEUR"]);
  if (!allowedPegTypes.has(pegType)) {
    throw new Error(`Unexpected peg type: ${pegType}`);
  }
  return `SELECT id FROM depeg_events WHERE peg_type = '${pegType}'`;
}
