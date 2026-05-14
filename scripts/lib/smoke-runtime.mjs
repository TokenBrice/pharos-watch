export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export function readEnvFirst(keys, fallback = "") {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const value = process.env[key];
    if (value != null && value !== "") {
      return value;
    }
  }
  return fallback;
}

export function readPositiveIntEnv(key, fallback) {
  return parsePositiveInt(process.env[key], fallback);
}

export function readNonNegativeIntEnv(key, fallback) {
  return parseNonNegativeInt(process.env[key], fallback);
}

export function readBooleanEnv(key, fallback) {
  return parseBoolean(process.env[key], fallback);
}

export function readCliValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseCliOptions(argv, handlers, { allowUnknown = true } = {}) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const handler = handlers[arg];
    if (!handler) {
      if (!allowUnknown && arg.startsWith("--")) {
        throw new Error(`Unknown argument: ${arg}`);
      }
      continue;
    }

    const result = handler({
      arg,
      argv,
      index,
      readValue: () => readCliValue(argv, index, arg),
    });
    if (result === "value") {
      index += 1;
    } else if (Number.isInteger(result) && result > index) {
      index = result;
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
