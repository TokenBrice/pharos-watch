export function resourceChildEnvironment(
  protocol: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+)$/.test(key)) env[key] = value;
  }
  return { ...env, ...protocol };
}

export function createResourceProbeEnv(
  parent: NodeJS.ProcessEnv,
  protocol: { contagion?: boolean; capturePath?: string } = {},
): NodeJS.ProcessEnv {
  return resourceChildEnvironment({
    ...(protocol.contagion ? { CONTAGION_MATRIX: "1" } : {}),
    ...(protocol.capturePath ? { SAFETY_SCORE_V9_RESOURCE_CAPTURE: protocol.capturePath } : {}),
  }, parent);
}
