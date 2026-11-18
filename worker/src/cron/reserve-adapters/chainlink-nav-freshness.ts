import { DAY_SECONDS } from "@shared/lib/time-constants";

export function chainlinkNavMaxOracleAgeSec(params: { maxOracleAgeSec?: number }): number {
  return params.maxOracleAgeSec ?? 2 * DAY_SECONDS;
}
