/** Minimum peg deviation (in basis points) to trigger a depeg event */
export const DEPEG_THRESHOLD_BPS = 100;

/** Maximum age (in seconds) for a DEX price observation to be considered fresh */
export const DEX_FRESHNESS_SEC = 1200;

/** D1 batch statement limit per db.batch() call */
export const D1_BATCH_SIZE = 100;
