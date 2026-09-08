import { execFile } from "node:child_process";

export function runOperatorCli(executable: string, args: string[], options: { cwd: string; encoding: "utf8" }) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(executable, args, { ...options, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== "number")) {
        reject(error);
        return;
      }
      resolve({ status: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}
