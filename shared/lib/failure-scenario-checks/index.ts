import type { ScenarioCheck } from "./context";
import crvusdChecks from "./crvusd-curve";
import cusdCapChecks from "./cusd-cap";
import ghoChecks from "./gho-aave";
import usdcChecks from "./usdc-circle";
import usdeChecks from "./usde-ethena";
import usdsChecks from "./usds-sky";
import usdtChecks from "./usdt-tether";
import usd1Checks from "./usd1-world-liberty-financial";
import lusdChecks from "./lusd-liquity";

/** Registry is the CLI's selection and required-chain authority. */
export const FAILURE_SCENARIO_CHECKS: Readonly<Record<string, {
  chainIds: readonly number[];
  checks: readonly ScenarioCheck[];
}>> = {
  "crvusd-curve": { chainIds: [1], checks: crvusdChecks },
  "gho-aave": { chainIds: [1], checks: ghoChecks },
  "usdc-circle": { chainIds: [1], checks: usdcChecks },
  "usde-ethena": { chainIds: [1], checks: usdeChecks },
  "usds-sky": { chainIds: [1], checks: usdsChecks },
  "usdt-tether": { chainIds: [1], checks: usdtChecks },
  "usd1-world-liberty-financial": { chainIds: [1, 56], checks: usd1Checks },
  "cusd-cap": { chainIds: [1], checks: cusdCapChecks },
  "lusd-liquity": { chainIds: [1], checks: lusdChecks },
};
