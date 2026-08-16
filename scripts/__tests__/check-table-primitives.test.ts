import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectTableInventory,
  scanTablePrimitives,
} from "../ci/check-table-primitives.ts";

let tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pharos-table-primitives-"));
  tempDirs.push(dir);
  return dir;
}

function writeFixture(cwd: string, file: string, source: string): void {
  const path = join(cwd, file);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, source);
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("scanTablePrimitives", () => {
  it("allows product code that uses the shared table primitives", () => {
    const cwd = makeTempRepo();
    writeFixture(
      cwd,
      "src/app/demo/page.tsx",
      'import { TableFrame } from "@/components/table";\nexport function Page() { return <TableFrame tableId="demo" />; }\n',
    );

    const report = scanTablePrimitives({ cwd });

    expect(report.scannedFiles).toHaveLength(1);
    expect(report.violations).toEqual([]);
  });

  it("rejects direct shadcn table imports in product source", () => {
    const cwd = makeTempRepo();
    writeFixture(
      cwd,
      "src/app/demo/page.tsx",
      'import { Table } from "@/components/ui/table";\nexport function Page() { return <Table />; }\n',
    );

    expect(scanTablePrimitives({ cwd }).violations).toEqual([
      {
        file: "src/app/demo/page.tsx",
        line: 1,
        kind: "ui-table-import",
        reason: "Import table primitives from @/components/table instead of @/components/ui/table.",
      },
    ]);
  });

  it("rejects relative and require shadcn table imports in product source", () => {
    const cwd = makeTempRepo();
    writeFixture(
      cwd,
      "src/app/demo/page.tsx",
      'import { Table } from "../../components/ui/table";\nconst required = require("../../components/ui/table.tsx");\nexport function Page() { return <Table data-required={Boolean(required)} />; }\n',
    );

    expect(scanTablePrimitives({ cwd }).violations).toEqual([
      {
        file: "src/app/demo/page.tsx",
        line: 1,
        kind: "ui-table-import",
        reason: "Import table primitives from @/components/table instead of @/components/ui/table.",
      },
      {
        file: "src/app/demo/page.tsx",
        line: 2,
        kind: "ui-table-import",
        reason: "Import table primitives from @/components/table instead of @/components/ui/table.",
      },
    ]);
  });

  it("rejects visible raw table markup in product source", () => {
    const cwd = makeTempRepo();
    writeFixture(
      cwd,
      "src/components/raw-table.tsx",
      "export function RawTable() { return <table><tbody /></table>; }\n",
    );

    expect(scanTablePrimitives({ cwd }).violations).toEqual([
      {
        file: "src/components/raw-table.tsx",
        line: 1,
        kind: "raw-table-markup",
        reason: "Use the shared table primitives instead of raw <table> markup.",
      },
    ]);
  });

  it("allows raw table markup in explicit implementation and fixture allowlists", () => {
    const cwd = makeTempRepo();
    writeFixture(
      cwd,
      "src/components/table/table-element.tsx",
      "export function TableElement() { return <table />; }\n",
    );
    writeFixture(
      cwd,
      "src/components/ui/table.tsx",
      "export function Table() { return <table />; }\n",
    );
    writeFixture(
      cwd,
      "src/components/chart-primitives/data-table.tsx",
      "export function ChartDataTable() { return <table><caption>Chart</caption></table>; }\n",
    );
    writeFixture(
      cwd,
      "tests/fixtures/raw-fragment.tsx",
      "export const fixture = <table><tbody /></table>;\n",
    );

    const report = scanTablePrimitives({ cwd, roots: ["src", "tests"] });

    expect(report.scannedFiles).toHaveLength(4);
    expect(report.violations).toEqual([]);
  });
});

describe("collectTableInventory", () => {
  it("lists table identity, primitive kind, chrome, density, naming, and duplicate swipe hints", () => {
    const cwd = makeTempRepo();
    writeFixture(
      cwd,
      "src/app/demo/page.tsx",
      `import { DataTableShell, MatrixTable } from "@/components/table";

export function Page() {
  return (
    <section>
      <p>Swipe table horizontally for details.</p>
      <DataTableShell tableId="markets" chrome="embedded" density="compact" columns={[]} />
      <MatrixTable tableId="matrix" caption="Matrix details" viewportProps={{ mobileScrollHint: false }} />
    </section>
  );
}
`,
    );

    expect(collectTableInventory({ cwd })).toEqual([
      {
        tableId: "markets",
        primitive: "DataTableShell",
        file: "src/app/demo/page.tsx",
        line: 7,
        chrome: "embedded",
        density: "compact",
        accessibleName: "aria-label",
        hasCaption: false,
        hasAriaLabel: true,
        mobileHint: "active-default",
        duplicateMobileSwipeHint: true,
      },
      {
        tableId: "matrix",
        primitive: "MatrixTable",
        file: "src/app/demo/page.tsx",
        line: 8,
        chrome: "default",
        density: "comfortable",
        accessibleName: "caption",
        hasCaption: true,
        hasAriaLabel: false,
        mobileHint: "disabled",
        duplicateMobileSwipeHint: false,
      },
    ]);
  });
});
