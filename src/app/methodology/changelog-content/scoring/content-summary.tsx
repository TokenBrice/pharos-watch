import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangelogDataTable, changelogTableClassNames } from "./content-shared";

const WEIGHT_EVOLUTION_COLUMNS = [
  { id: "version", label: "Version", rowHeader: true },
  { id: "peg", label: "Peg" },
  { id: "liquidity", label: "Liquidity" },
  { id: "safety", label: "Safety" },
  { id: "resilience", label: "Resilience" },
  { id: "decentralization", label: "Decentralization" },
  { id: "dependencyRisk", label: "Dep Risk" },
];

const WEIGHT_EVOLUTION_ROWS = [
  ["v1.0", "25%", "25%", "20%", "15%", "10%", "5%"],
  ["v1.0 patch", "25%", "25%", "20%", "10%", "5%", "15%"],
  ["v2.0", "25%", "25%", "removed", "15%", "10%", "25%"],
  ["v3.0", "25%", "20%", "—", "20%", "10%", "25%"],
  ["v3.3", "25%", "20%", "—", "20%", "15%", "25%"],
  ["v4.0", "multiplier", "25%", "—", "25%", "10%", "30%"],
  ["v4.1", "multiplier", "30%", "—", "20%", "15%", "25%"],
  ["v5.0–v8.17", "multiplier", "30%", "—", "20%", "15%", "25%"],
].map(([version, peg, liquidity, safety, resilience, decentralization, dependencyRisk]) => ({
  id: version,
  cells: { version, peg, liquidity, safety, resilience, decentralization, dependencyRisk },
}));

const GRADE_EVOLUTION_COLUMNS = [
  { id: "grade", label: "Grade", rowHeader: true },
  { id: "v1", label: "v1.0" },
  { id: "v4", label: <>v4.0 (&minus;5)</> },
  { id: "v5", label: <>v5.1 (&minus;5)</>, cellClassName: changelogTableClassNames.rowHeader },
];

const GRADE_EVOLUTION_ROWS = [
  ["A+", "97", "92", "87"], ["A", "93", "88", "83"], ["A−", "90", "85", "80"],
  ["B+", "85", "80", "75"], ["B", "80", "75", "70"], ["B−", "75", "70", "65"],
  ["C+", "70", "65", "60"], ["C", "65", "60", "55"], ["C−", "60", "55", "50"],
  ["D", "50", "45", "40"], ["F", "0", "0", "0"],
].map(([grade, v1, v4, v5]) => ({ id: grade, cells: { grade, v1, v4, v5 } }));

export function ScoringChangelogSummaryTables() {
  return (
    <>
      {/* ──────────── Summary tables ──────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle as="h2">Quick Reference</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Weight evolution (V8 and earlier)</h3>
            <p>V9 replaced these dimensions with Backing 40%, Exit 35%, and Economic Control 25%.</p>
            <ChangelogDataTable
              ariaLabel="Safety Score weight evolution"
              tableId="scoring-weight-evolution"
              testId="scoring-weight-evolution-table"
              columns={WEIGHT_EVOLUTION_COLUMNS}
              rows={WEIGHT_EVOLUTION_ROWS}
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Grade threshold evolution</h3>
            <ChangelogDataTable
              ariaLabel="Safety Score grade threshold evolution"
              tableId="scoring-grade-threshold-evolution"
              testId="scoring-grade-threshold-evolution-table"
              columns={GRADE_EVOLUTION_COLUMNS}
              rows={GRADE_EVOLUTION_ROWS}
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
