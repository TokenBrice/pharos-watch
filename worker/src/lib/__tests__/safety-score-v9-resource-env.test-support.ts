export function createResourceProbeEnv(
  parent: NodeJS.ProcessEnv,
  protocol: { contagion?: boolean; capturePath?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && (/^(PATH|HOME|TMPDIR|TEMP|TMP|LANG)$/.test(key) || key.startsWith("LC_"))) {
      env[key] = value;
    }
  }
  if (protocol.contagion) env.CONTAGION_MATRIX = "1";
  if (protocol.capturePath) env.SAFETY_SCORE_V9_RESOURCE_CAPTURE = protocol.capturePath;
  return env;
}
