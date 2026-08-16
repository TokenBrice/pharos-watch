import {
  estimateTelegramDrainTimeSec,
  readTelegramPendingCapacity,
  readTelegramPendingCapacitySnapshot,
  TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
} from "../../lib/telegram-pending-capacity";

export {
  estimateTelegramDrainTimeSec,
  readTelegramPendingCapacity as readPendingCapacity,
  readTelegramPendingCapacitySnapshot as readPendingCapacitySnapshot,
  TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT as EXECUTION_UNKNOWN_SAMPLE_LIMIT,
};
