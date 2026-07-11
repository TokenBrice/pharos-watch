import { jsonResponse } from "../lib/api-utils";
import { makeAdminRoute, type AdminRouteContext } from "../lib/route-wrappers";
import { loadTelegramAdoptionWeeklyReport } from "../lib/telegram-adoption-analytics";

export const handleAdminTelegramAdoptionReport = makeAdminRoute<AdminRouteContext>(
  "route-admin-telegram-adoption-report",
  async ({ db }) => jsonResponse(await loadTelegramAdoptionWeeklyReport(db), { noStore: true }),
);
