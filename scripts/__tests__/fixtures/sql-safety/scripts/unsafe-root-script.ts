export function unsafeRootScriptValueInterpolation(pegType: string) {
  return `SELECT id FROM depeg_events WHERE peg_type = '${pegType}'`;
}
