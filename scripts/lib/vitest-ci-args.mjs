export function hasVitestOption(args, optionName) {
  return args.some((arg, index) => {
    if (arg === optionName || arg.startsWith(`${optionName}=`)) {
      return true;
    }
    return args[index - 1] === optionName;
  });
}

export function withCiVitestArgs(args, env = process.env) {
  if (env.CI !== "true" || env.PHAROS_CI_VITEST_COMPACT === "0") {
    return args;
  }

  const nextArgs = [...args];
  if (!hasVitestOption(nextArgs, "--silent")) {
    nextArgs.push("--silent=passed-only");
  }
  return nextArgs;
}
