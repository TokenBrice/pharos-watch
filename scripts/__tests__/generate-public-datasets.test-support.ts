import { cp, mkdir, readdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";

export async function copyDatasetWorkspace(root: string): Promise<void> {
  const repo = path.resolve(import.meta.dirname, "../..");
  await mkdir(path.join(root, "scripts/maintenance"), { recursive: true });
  await mkdir(path.join(root, "src/lib"), { recursive: true });
  for (const name of ["shared", "node_modules", "scripts/lib"]) {
    await symlink(path.join(repo, name), path.join(root, name));
  }
  for (const name of ["package.json", "tsconfig.json", "tsconfig.base.json", "scripts/maintenance/generate-public-datasets.ts", "public/datasets", "public/_redirects"]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await cp(path.join(repo, name), path.join(root, name), { recursive: true });
  }
  for (const name of await readdir(path.join(repo, "src/lib"))) {
    const source = path.join(repo, "src/lib", name);
    const target = path.join(root, "src/lib", name);
    if (name === "datasets") await cp(source, target, { recursive: true });
    else await symlink(source, target);
  }
}

export async function datasetBytes(root: string): Promise<Record<string, string>> {
  const files = ["public/_redirects", "src/lib/datasets/public-dataset-current.ts"];
  for (const name of await readdir(path.join(root, "public/datasets"), { recursive: true, withFileTypes: true })) {
    if (name.isFile()) files.push(path.relative(root, path.join(name.parentPath, name.name)));
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [file, (await readFile(path.join(root, file))).toString("base64")])));
}
