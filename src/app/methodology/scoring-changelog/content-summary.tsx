import { SAFETY_SCORE_VERSION_LABEL } from "@shared/lib/safety-score-version";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ScoringChangelogSummaryTables() {
  return (
    <>
            {/* ──────────── Summary tables ──────────── */}
            <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
              <CardHeader>
                <CardTitle as="h2">Quick Reference</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 text-sm text-muted-foreground leading-relaxed">
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Weight evolution</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Version
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Peg
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Liquidity
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Safety
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Resilience
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Decentralization
                          </th>
                          <th scope="col" className="py-2 font-medium text-foreground">
                            Dep Risk
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {[
                          ["v1.0", "25%", "25%", "20%", "15%", "10%", "5%"],
                          ["v1.0 patch", "25%", "25%", "20%", "10%", "5%", "15%"],
                          ["v2.0", "25%", "25%", "removed", "15%", "10%", "25%"],
                          ["v3.0", "25%", "20%", "\u2014", "20%", "10%", "25%"],
                          ["v3.3", "25%", "20%", "\u2014", "20%", "15%", "25%"],
                          [
                            "v4.0",
                            "multiplier",
                            "25%",
                            "\u2014",
                            "25%",
                            "10%",
                            "30%",
                          ],
                          [
                            "v4.1",
                            "multiplier",
                            "30%",
                            "\u2014",
                            "20%",
                            "15%",
                            "25%",
                          ],
                          [
                            `v5.0\u2013${SAFETY_SCORE_VERSION_LABEL.replace(/^v/, "")}`,
                            "multiplier",
                            "30%",
                            "\u2014",
                            "20%",
                            "15%",
                            "25%",
                          ],
                        ].map(([v, ...rest]) => (
                          <tr key={v}>
                            <td className="py-2 pr-4 text-foreground font-medium">
                              {v}
                            </td>
                            {rest.map((val, i) => (
                              <td key={i} className="py-2 pr-4 last:pr-0">
                                {val}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">
                    Grade threshold evolution
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            Grade
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            v1.0
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                            v4.0 (&minus;5)
                          </th>
                          <th scope="col" className="py-2 font-medium text-foreground">
                            v5.1 (&minus;5)
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
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
                          <tr key={grade}>
                            <td className="py-2 pr-4 text-foreground font-medium">
                              {grade}
                            </td>
                            <td className="py-2 pr-4">{v1}</td>
                            <td className="py-2 pr-4">{v4}</td>
                            <td className="py-2 text-foreground font-medium">
                              {v5}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>
    </>
  );
}
