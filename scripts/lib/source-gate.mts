import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { collectSourceFiles, resolveSourceRoot } from "./source-files.mts";

interface SourceGateFile {
  absolutePath: string;
  relativePath: string;
  content: string;
  root: string;
}

interface ScanSourceGateOptions<Violation> {
  roots: readonly string[];
  cwd?: string;
  extensions?: Iterable<string>;
  excludedDirs?: Iterable<string>;
  scanFile: (file: SourceGateFile) => Iterable<Violation>;
}

export function scanSourceGate<Violation>({
  roots,
  cwd = process.cwd(),
  extensions,
  excludedDirs,
  scanFile,
}: ScanSourceGateOptions<Violation>): { scannedFiles: string[]; violations: Violation[] } {
  const scannedFiles: string[] = [];
  const violations: Violation[] = [];

  for (const root of roots) {
    const files = collectSourceFiles(resolveSourceRoot(root, cwd), { extensions, excludedDirs });
    scannedFiles.push(...files);
    for (const absolutePath of files) {
      violations.push(...scanFile({
        absolutePath,
        relativePath: relative(cwd, absolutePath),
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- source roots are explicit gate inputs
        content: readFileSync(absolutePath, "utf8"),
        root,
      }));
    }
  }

  return { scannedFiles, violations };
}
