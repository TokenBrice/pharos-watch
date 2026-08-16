import { resolve } from "node:path";

export function localBin(name: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return resolve("node_modules", ".bin", `${name}${suffix}`);
}
