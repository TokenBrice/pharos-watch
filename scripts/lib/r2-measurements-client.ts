import { SignedR2ObjectClient, type R2ObjectClientOptions } from "./r2-object-client";

export const R2_MEASUREMENTS_BUCKET = "pharos-measurements";
export const R2_MEASUREMENTS_ACCESS_KEY_ENV = "R2_MEASUREMENTS_ACCESS_KEY_ID";
export const R2_MEASUREMENTS_SECRET_KEY_ENV = "R2_MEASUREMENTS_SECRET_ACCESS_KEY";
export const R2_MEASUREMENTS_ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";

/** Measurements keep their dedicated bucket and credential scope on the shared transport. */
export function createR2MeasurementsClient(
  options: Omit<R2ObjectClientOptions, "bucket" | "accessKeyEnv" | "secretKeyEnv"> = {},
): SignedR2ObjectClient {
  return new SignedR2ObjectClient({
    ...options,
    accountId: options.accountId ?? process.env[R2_MEASUREMENTS_ACCOUNT_ENV],
    bucket: R2_MEASUREMENTS_BUCKET,
    accessKeyEnv: R2_MEASUREMENTS_ACCESS_KEY_ENV,
    secretKeyEnv: R2_MEASUREMENTS_SECRET_KEY_ENV,
  });
}
