import { execFile } from "node:child_process";
import { shellArgs } from "./platform.js";

export interface ExecResult {
  output: string;
  exitCode: number;
}

export function execCommand(
  command: string,
  timeout: number = 60_000,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [shell, args] = shellArgs(command);
    execFile(
      shell,
      args,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        cwd: process.cwd(),
      },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          if (error.killed) {
            reject(
              new Error(`Command timed out after ${timeout}ms: ${command}`),
            );
          } else {
            reject(new Error(`Command failed: ${error.message}`));
          }
          return;
        }
        const exitCode = error
          ? (typeof error.code === "number" ? error.code : -1)
          : 0;
        resolve({ output: (stdout + stderr).trim(), exitCode });
      },
    );
  });
}
