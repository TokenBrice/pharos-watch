import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import type { SelectedPegReference } from "@shared/types/fx-reference";
import { getNativeEventPriceObservation, type NativeEventPriceEvidence } from "@shared/lib/depeg-quote-domain";
import { decodeNativeEventQuote } from "./native-peg-quote-cache";

export function readAdmittedNativeEventObservation(
  event: NativeEventPriceEvidence & { stablecoin_id: string; current_native_quote?: string | null },
  now: number,
) {
  const cached = decodeNativeEventQuote(event.current_native_quote ?? null);
  const lineage = cached?.derivation?.lineage;
  const traded = cached?.derivation?.kind === "traded-pair" && lineage?.venue?.trim() && lineage?.pair?.trim() ? cached : null;
  const cnh = event.stablecoin_id === "axcnh-anchorx";
  if (cnh && (!traded || !/(?:^|[^a-z])CNH(?:$|[^a-z])/i.test(lineage?.pair ?? ""))) return null;
  const observation = getNativeEventPriceObservation(cnh ? { ...event, start_price: null, recovery_price: null } : event, now, traded);
  return observation && { ...observation,
    traded: traded?.observedAt === observation.observedAt && traded.value === observation.value };
}

/** Only the accepted denominator and repricing samples from its decision session may vote. */
export function getPublishedReferenceEvidence(
  selection: SelectedPegReference | undefined, generation: string, decisionAtSec: number,
) {
  if (!selection || selection.generation !== generation) return undefined;
  if (selection.kind === "median") return selection;
  const { kind, observation, repricing } = selection;
  const session = getReferenceSessionState(kind === "fx" ? "fx" : "metal", decisionAtSec);
  const sameSession = session.open && repricing?.sessionOpenedAtSec === session.sessionOpenedAtSec &&
    repricing.source === observation.source;
  return { kind, generation, usdPerUnit: observation.usdPerUnit, observation,
    ...(sameSession ? { preCloseUsdPerUnit: repricing.preCloseUsdPerUnit,
      firstInSessionObservedAtSec: repricing.firstInSessionObservedAtSec } : {}),
  };
}
