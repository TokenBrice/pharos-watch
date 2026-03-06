import type { StatusTransition } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TransitionTimelineProps {
  transitions: StatusTransition[];
}

export function TransitionTimeline({ transitions }: TransitionTimelineProps) {
  if (!transitions || transitions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Incident Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No status transitions recorded yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Incident Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Status transition history</caption>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th scope="col" className="pb-2 font-medium">Time</th>
                <th scope="col" className="pb-2 font-medium">Transition</th>
                <th scope="col" className="pb-2 font-medium">Raw</th>
                <th scope="col" className="pb-2 font-medium">Reason</th>
                <th scope="col" className="pb-2 font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody>
            {transitions.map((transition) => (
              <tr key={transition.id} className="border-b last:border-0">
                <th scope="row" className="py-2 text-xs text-muted-foreground text-left font-normal">
                  {new Date(transition.at * 1000).toLocaleString()}
                </th>
                <td className="py-2 font-mono text-xs">
                  {(transition.from ?? "init")} → {transition.to}
                </td>
                  <td className="py-2 font-mono text-xs">{transition.rawStatus}</td>
                  <td className="py-2 text-xs text-muted-foreground">{transition.reason}</td>
                  <td className="py-2 font-mono text-xs">{(transition.confidence * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
