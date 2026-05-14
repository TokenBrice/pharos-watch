import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createD1Client,
  sqlString,
  type D1Client,
  type D1Target,
  type RemoteD1Client,
} from "../../../scripts/lib/remote-d1";

export { sqlString, type RemoteD1Client };

const WORKER_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function createWorkerD1Client(
  database: string,
  target: D1Target = "remote",
  options: { cwd?: string } = {},
): D1Client {
  return createD1Client(database, {
    cwd: options.cwd ?? WORKER_CWD,
    maxBuffer: 64 * 1024 * 1024,
    target,
  });
}

export function createRemoteD1Client(database: string): RemoteD1Client {
  return createWorkerD1Client(database, "remote");
}
