import { deleteCache, getCache, setCache } from "./db-cache";

export const DDR_REPAIR_DEBT_CACHE_KEY = "ddr:repair-debt:v1";
const DDR_REPAIR_DEBT_EVENT_LIMIT = 25;

export interface DdrRepairDebtEvent {
  eventId: number;
  reason: string;
}

export interface DdrRepairDebtSummary {
  checkedAt: number;
  count: number;
  events: DdrRepairDebtEvent[];
  eventsTruncated: boolean;
}

function isRepairDebtEvent(value: unknown): value is DdrRepairDebtEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === "number" && Number.isFinite(record.eventId) && typeof record.reason === "string";
}

export function buildDdrRepairDebtSummary(
  events: readonly DdrRepairDebtEvent[],
  checkedAt: number,
): DdrRepairDebtSummary {
  const sortedEvents = [...events].sort((a, b) => a.eventId - b.eventId);
  return {
    checkedAt,
    count: sortedEvents.length,
    events: sortedEvents.slice(0, DDR_REPAIR_DEBT_EVENT_LIMIT),
    eventsTruncated: sortedEvents.length > DDR_REPAIR_DEBT_EVENT_LIMIT,
  };
}

export async function persistDdrRepairDebt(
  db: D1Database,
  events: readonly DdrRepairDebtEvent[],
  checkedAt: number,
  signal?: AbortSignal,
): Promise<DdrRepairDebtSummary | null> {
  if (events.length === 0) {
    await deleteCache(db, DDR_REPAIR_DEBT_CACHE_KEY);
    return null;
  }

  const summary = buildDdrRepairDebtSummary(events, checkedAt);
  await setCache(db, DDR_REPAIR_DEBT_CACHE_KEY, JSON.stringify(summary), signal);
  return summary;
}

export async function loadDdrRepairDebt(db: D1Database): Promise<DdrRepairDebtSummary | null> {
  const cached = await getCache(db, DDR_REPAIR_DEBT_CACHE_KEY);
  if (!cached) return null;

  const parsed = JSON.parse(cached.value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const checkedAt = typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt)
    ? record.checkedAt
    : cached.updatedAt;
  const count = typeof record.count === "number" && Number.isFinite(record.count)
    ? Math.max(0, Math.floor(record.count))
    : 0;
  const events = Array.isArray(record.events) ? record.events.filter(isRepairDebtEvent) : [];
  const eventsTruncated = record.eventsTruncated === true || count > events.length;
  return {
    checkedAt,
    count,
    events,
    eventsTruncated,
  };
}
