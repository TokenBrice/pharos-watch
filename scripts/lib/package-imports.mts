import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

interface PackageImportsFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  statSync?(path: string): { isFile(): boolean };
  realpathSync?(path: string): string;
}

interface LocalPackages {
  imports: Record<string, unknown>;
  workspaces: Map<string, Map<string, string>>;
}

const defaultFs: PackageImportsFs = { existsSync, readFileSync, realpathSync, statSync };
// Keep fixture/history readers isolated from the checkout and from each other.
const manifestCache = new WeakMap<PackageImportsFs, Map<string, LocalPackages>>();

function isWithin(root: string, target: string): boolean {
  const local = relative(root, target);
  return !!local && !isAbsolute(local) && local !== ".." && !local.startsWith("../");
}

function localTarget(target: unknown, root: string, label: string): string {
  if (typeof target !== "string" || !target.startsWith("./") || /[*\\]/.test(target)) {
    throw new Error(`${label} must map to an exact local relative file`);
  }
  const segments = target.slice(2).split("/");
  const absolute = resolve(root, target);
  if (segments.some((segment) => segment === ".." || segment === "node_modules") || !isWithin(root, absolute)) {
    throw new Error(`${label} escapes the repository source tree`);
  }
  return absolute;
}

function discoverPackages(root: string, fsImpl: PackageImportsFs): LocalPackages {
  let roots = manifestCache.get(fsImpl);
  if (!roots) manifestCache.set(fsImpl, roots = new Map());
  const cached = roots.get(root);
  if (cached) return cached;
  const packages: LocalPackages = { imports: {}, workspaces: new Map() };
  const packagePath = resolve(root, "package.json");
  if (fsImpl.existsSync(packagePath)) {
    const manifest = JSON.parse(fsImpl.readFileSync(packagePath, "utf8")) as {
      imports?: Record<string, unknown>;
      workspaces?: string[];
    };
    packages.imports = manifest.imports ?? {};
    for (const workspace of manifest.workspaces ?? []) {
      // This repository declares explicit paths, not workspace globs.
      if (typeof workspace !== "string" || /[*?{}[\]\\\\]/.test(workspace)) {
        throw new Error("Local workspaces must use explicit repository-relative paths");
      }
      const directory = resolve(root, workspace);
      if (!isWithin(root, directory)) throw new Error(`Workspace ${workspace} escapes the repository source tree`);
      const workspacePath = resolve(directory, "package.json");
      if (!fsImpl.existsSync(workspacePath)) throw new Error(`Missing workspace manifest ${workspacePath}`);
      const local = JSON.parse(fsImpl.readFileSync(workspacePath, "utf8")) as { name?: string; exports?: unknown };
      // Workspaces without exports retain their existing external-package behavior.
      if (local.exports === undefined) continue;
      if (typeof local.name !== "string" || !local.name) throw new Error(`Missing workspace package name in ${workspacePath}`);
      if (packages.workspaces.has(local.name)) throw new Error(`Duplicate workspace package ${local.name}`);
      const exports = typeof local.exports === "string" ? { ".": local.exports } : local.exports;
      if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
        throw new Error(`Workspace ${local.name} exports must declare exact local subpaths`);
      }
      const targets = new Map<string, string>();
      for (const [subpath, target] of Object.entries(exports)) {
        if ((subpath !== "." && !subpath.startsWith("./")) || /[*\\\\%?#]/.test(subpath)
          || subpath.split("/").some((part) => part === ".." || part === "node_modules")) {
          throw new Error(`Workspace ${local.name} exports must declare exact local subpaths`);
        }
        const label = `Workspace export ${local.name}${subpath === "." ? "" : subpath.slice(1)}`;
        if (typeof target === "string" && /[%?#]/.test(target)) {
          throw new Error(`${label} must map to an exact local relative file`);
        }
        const absolute = localTarget(target, directory, label);
        if (fsImpl.realpathSync && fsImpl.existsSync(absolute)) {
          const realRoot = fsImpl.realpathSync(root);
          const realDirectory = fsImpl.realpathSync(directory);
          if (!isWithin(realRoot, realDirectory) || !isWithin(realDirectory, fsImpl.realpathSync(absolute))) {
            throw new Error(`${label} escapes the repository source tree`);
          }
        }
        targets.set(subpath, absolute);
      }
      packages.workspaces.set(local.name, targets);
    }
  }
  roots.set(root, packages);
  return packages;
}

/** Resolve exact local package-private imports and declared workspace exports as data. */
export function resolveLocalPackageImport(
  specifier: string,
  root = process.cwd(),
  fsImpl: PackageImportsFs = defaultFs,
): string | null {
  if (specifier.startsWith(".") || isAbsolute(specifier)) return null;
  root = resolve(root);
  const packages = discoverPackages(root, fsImpl);
  if (specifier.startsWith("#")) {
    if (specifier.includes("*")) return null;
    const target = packages.imports[specifier];
    return target == null ? null : localTarget(target, root, `Package import ${specifier}`);
  }
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const exports = packages.workspaces.get(name);
  if (!exports) return null;
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  const target = exports.get(subpath);
  if (!target) throw new Error(`Unresolved workspace export ${specifier}: subpath is not exported`);
  if (!fsImpl.existsSync(target) || (fsImpl.statSync && !fsImpl.statSync(target).isFile())) {
    throw new Error(`Unresolved workspace export ${specifier}: source file does not exist (${target})`);
  }
  return target;
}
