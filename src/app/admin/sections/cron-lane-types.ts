import type { StatusResponse } from "@shared/types/status/response";

export interface CronGroup {
  key: string;
  title: string;
  badge: string;
  description: string;
  entries: [string, StatusResponse["crons"][string]][];
}
