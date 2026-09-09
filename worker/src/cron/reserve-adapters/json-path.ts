type JsonObject = Record<string, unknown>;

export function getJsonPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (Array.isArray(current)) {
      if (!(part.length > 0 && /^\d+$/.test(part))) return null;
      const index = Number(part);
      if (!Number.isSafeInteger(index)) return null;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return null;
    current = (current as JsonObject)[part];
  }
  return current;
}
