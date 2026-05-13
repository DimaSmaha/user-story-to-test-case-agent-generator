import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");

export const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*[mGKHFJABCDST]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "");

export function killProcess(proc: ChildProcess): void {
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { shell: true });
  } else {
    proc.kill("SIGTERM");
  }
}

export function spawnLines(
  args: string[],
  onLine: (line: string) => void,
  onClose: (code: number | null) => void,
): ChildProcess {
  const proc = spawn("npx", args, {
    cwd: PROJECT_ROOT,
    shell: true,
    env: process.env,
  });

  let buf = "";
  const handle = (data: Buffer) => {
    buf += data.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim()) onLine(line);
    }
  };

  proc.stdout?.on("data", handle);
  proc.stderr?.on("data", handle);
  proc.on("close", (code) => {
    if (buf.trim()) onLine(buf);
    buf = "";
    onClose(code);
  });

  return proc;
}
