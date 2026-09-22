export function parseCalibrationArgs(argv, stdout = process.stdout) {
  const usage =
    "Usage: npm run safety-score-v9:calibration-analysis -- --baseline <replay> --candidate <replay> " +
    "[--composite <replay>] [--fresh-capture <replay> ... exactly 3] [--attribution <json>] [--output <json>]";
  if (argv.includes("--help")) {
    stdout.write(`${usage}\n`);
    return null;
  }
  const parsed = {
    baseline: null,
    candidate: null,
    composite: null,
    attribution: null,
    output: null,
    freshCaptures: [],
  };
  const keys = new Map([
    ["--baseline", "baseline"],
    ["--candidate", "candidate"],
    ["--composite", "composite"],
    ["--attribution", "attribution"],
    ["--output", "output"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = argv[index + 1];
    if (option === "--fresh-capture") {
      if (!next || next.startsWith("--")) throw new Error(`${option} requires a path\n${usage}`);
      parsed.freshCaptures.push(next);
      index += 1;
      continue;
    }
    const key = keys.get(option);
    if (!key) throw new Error(`Unknown option ${option}\n${usage}`);
    if (!next || next.startsWith("--")) throw new Error(`${option} requires a path\n${usage}`);
    if (parsed[key] !== null) throw new Error(`${option} may be supplied only once\n${usage}`);
    parsed[key] = next;
    index += 1;
  }
  if (!parsed.baseline || !parsed.candidate) throw new Error(usage);
  return parsed;
}
export function readCalibrationInputs(args, readText) {
  return {
    baseline: JSON.parse(readText(args.baseline)),
    candidate: JSON.parse(readText(args.candidate)),
    fridayEvidence: {
      ...(args.composite ? { composite: JSON.parse(readText(args.composite)) } : {}),
      ...(args.freshCaptures.length > 0
        ? { freshCaptures: args.freshCaptures.map((path) => JSON.parse(readText(path))) }
        : {}),
      ...(args.attribution ? { causalAttribution: JSON.parse(readText(args.attribution)) } : {}),
    },
  };
}
export function serializeCalibrationReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
