import { coverageFeature as blacklist } from "@/lib/coverage/blacklist";
import { coverageFeature as dependency } from "@/lib/coverage/dependency";
import { coverageFeature as dex } from "@/lib/coverage/dex";
import { coverageFeature as flows } from "@/lib/coverage/flows";
import { coverageFeature as genius } from "@/lib/coverage/genius";
import { coverageFeature as mintAuthority } from "@/lib/coverage/mint-authority";
import { coverageFeature as mica } from "@/lib/coverage/mica";
import { coverageFeature as price } from "@/lib/coverage/price";
import { coverageFeature as redemption } from "@/lib/coverage/redemption";
import { coverageFeature as reserves } from "@/lib/coverage/reserves";
import { coverageFeature as safety } from "@/lib/coverage/safety";
import { coverageFeature as yieldFeature } from "@/lib/coverage/yield";
import type { CoverageFeatureModule } from "@/lib/coverage/shared";
import type { CoverageFeatureKey, CoverageStatus } from "@/lib/coverage-types";

export const COVERAGE_FEATURE_MODULES = {
  price,
  safety,
  dex,
  reserves,
  redemption,
  yield: yieldFeature,
  flows,
  blacklist,
  mica,
  genius,
  dependency,
  mintAuthority,
} satisfies Record<CoverageFeatureKey, CoverageFeatureModule<(...args: never[]) => CoverageStatus>>;
