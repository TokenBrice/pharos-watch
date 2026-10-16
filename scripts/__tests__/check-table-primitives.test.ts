import { afterEach, describe, expect, it } from "vitest";

import {
  scanTablePrimitives,
} from "../ci/check-table-primitives.ts";
import { createTempRepoTracker } from "./helpers/test-state";

const { cleanup, makeRoot, writeText } = createTempRepoTracker("pharos-table-primitives");

afterEach(cleanup);

describe("scanTablePrimitives", () => {
  it("rejects direct shadcn table imports in product source", () => {
    const cwd = makeRoot();
    writeText(
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
    const cwd = makeRoot();
    writeText(
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
    const cwd = makeRoot();
    writeText(
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
    const cwd = makeRoot();
    writeText(
      cwd,
      "src/components/table/table-element.tsx",
      "export function TableElement() { return <table />; }\n",
    );
    writeText(
      cwd,
      "src/components/ui/table.tsx",
      "export function Table() { return <table />; }\n",
    );
    writeText(
      cwd,
      "src/components/chart-primitives/data-table.tsx",
      "export function ChartDataTable() { return <table><caption>Chart</caption></table>; }\n",
    );
    writeText(
      cwd,
      "tests/fixtures/raw-fragment.tsx",
      "export const fixture = <table><tbody /></table>;\n",
    );

    const report = scanTablePrimitives({ cwd, roots: ["src", "tests"] });

    expect(report.scannedFiles).toHaveLength(4);
    expect(report.violations).toEqual([]);
  });
});

