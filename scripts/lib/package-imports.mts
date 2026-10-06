import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

interface PackageImportsFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
}

/** Resolve exact, local package-private imports without loading executable code. */
export function resolveLocalPackageImport(
  specifier: string,
  root = process.cwd(),
  fsImpl: PackageImportsFs = { existsSync, readFileSync },
): string | null {
  if (!specifier.startsWith("#") || specifier.includes("*")) return null;
  const packagePath = resolve(root, "package.json");
  if (!fsImpl.existsSync(packagePath)) return null;
  const manifest = JSON.parse(fsImpl.readFileSync(packagePath, "utf8")) as { imports?: Record<string, unknown> };
  const target = manifest.imports?.[specifier];
  if (target == null) return null;
  if (typeof target !== "string" || !target.startsWith("./") || target.includes("*") || target.includes("\\")) {
    throw new Error(`Package import ${specifier} must map to an exact local relative file`);
  }
  const segments = target.slice(2).split("/");
  if (segments.some((segment) => segment === ".." || segment === "node_modules")) {
    throw new Error(`Package import ${specifier} escapes the repository source tree`);
  }
  const absolute = resolve(root, target);
  const local = relative(resolve(root), absolute);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith("../")) {
    throw new Error(`Package import ${specifier} escapes the repository source tree`);
  }
  return absolute;
}
