import type { ConsolidatedAlerts } from "../../../telegram/common/alerts-formatting";

type StablecoinAlert = { stablecoinId: string };

function itemKey(kind: string, event: StablecoinAlert): string {
  return `${kind}:${event.stablecoinId}`;
}

export function listTelegramAlertItemKeys(alerts: ConsolidatedAlerts): string[] {
  const keys = [
    ...alerts.dews.map((event) => itemKey("dews", event)),
    ...alerts.depegTriggered.map((event) => itemKey("depeg-triggered", event)),
    ...alerts.depegResolved.map((event) => itemKey("depeg-resolved", event)),
    ...alerts.depegWorsening.map((event) => itemKey("depeg-worsening", event)),
    ...alerts.safety.map((event) => itemKey("safety", event)),
    ...alerts.launch.map((event) => itemKey("launch", event)),
    ...alerts.reserve.map((event) => itemKey("reserve", event)),
    ...(alerts.freeze ?? []).map((event) => `freeze:${event.tapeEventId}`),
  ];
  return [...new Set(keys)].sort();
}
