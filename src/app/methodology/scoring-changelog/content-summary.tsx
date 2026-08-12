import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangelogTable, changelogTableClassNames } from "./content-shared";

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
            <ChangelogTable
              ariaLabel="Safety Score weight evolution"
              tableId="scoring-weight-evolution"
              testId="scoring-weight-evolution-table"
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Version
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Peg
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Liquidity
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Safety
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Resilience
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Decentralization
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Dep Risk
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  ["v1.0", "25%", "25%", "20%", "15%", "10%", "5%"],
                  ["v1.0 patch", "25%", "25%", "20%", "10%", "5%", "15%"],
                  ["v2.0", "25%", "25%", "removed", "15%", "10%", "25%"],
                  ["v3.0", "25%", "20%", "\u2014", "20%", "10%", "25%"],
                  ["v3.3", "25%", "20%", "\u2014", "20%", "15%", "25%"],
                  ["v4.0", "multiplier", "25%", "\u2014", "25%", "10%", "30%"],
                  ["v4.1", "multiplier", "30%", "\u2014", "20%", "15%", "25%"],
                  [
                    "v5.0\u2013v8.17",
                    "multiplier",
                    "30%",
                    "\u2014",
                    "20%",
                    "15%",
                    "25%",
                  ],
                ].map(([v, ...rest]) => (
                  <TableRow key={v}>
                    <TableCell className={changelogTableClassNames.rowHeader}>{v}</TableCell>
                    {rest.map((val, i) => (
                      <TableCell key={i} className={changelogTableClassNames.cell}>
                        {val}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </ChangelogTable>
          </div>

          <div className="space-y-2">
            <h3 className="text-foreground font-medium">Grade threshold evolution</h3>
            <ChangelogTable
              ariaLabel="Safety Score grade threshold evolution"
              tableId="scoring-grade-threshold-evolution"
              testId="scoring-grade-threshold-evolution-table"
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    Grade
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    v1.0
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    v4.0 (&minus;5)
                  </TableHead>
                  <TableHead scope="col" className={changelogTableClassNames.head}>
                    v5.1 (&minus;5)
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  ["A+", "97", "92", "87"],
                  ["A", "93", "88", "83"],
                  ["A\u2212", "90", "85", "80"],
                  ["B+", "85", "80", "75"],
                  ["B", "80", "75", "70"],
                  ["B\u2212", "75", "70", "65"],
                  ["C+", "70", "65", "60"],
                  ["C", "65", "60", "55"],
                  ["C\u2212", "60", "55", "50"],
                  ["D", "50", "45", "40"],
                  ["F", "0", "0", "0"],
                ].map(([grade, v1, v4, v5]) => (
                  <TableRow key={grade}>
                    <TableCell className={changelogTableClassNames.rowHeader}>{grade}</TableCell>
                    <TableCell className={changelogTableClassNames.cell}>{v1}</TableCell>
                    <TableCell className={changelogTableClassNames.cell}>{v4}</TableCell>
                    <TableCell className={changelogTableClassNames.rowHeader}>{v5}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ChangelogTable>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
