import type { BlacklistStatusBucketKey } from "@shared/lib/blacklist-status-buckets";

export const FREEZEWATCH_BUCKET_LABELS: Record<BlacklistStatusBucketKey, string> = {
  yes: "Direct freeze",
  upstream: "Upstream exposure",
  possible: "Possible controls",
  no: "Unfreezable",
};

export const FREEZEWATCH_BUCKET_DESCRIPTIONS: Record<BlacklistStatusBucketKey, string> = {
  yes: "Issuer or contract can freeze, block, or seize holder balances.",
  upstream: "No direct lock; backed by freezable collateral or parent assets.",
  possible: "Upgradeable or pausable admin controls without confirmed address freezing.",
  no: "No direct, upstream, or admin freeze path in reviewed model.",
};
