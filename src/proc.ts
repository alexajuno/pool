import { spawn } from "node:child_process";

export interface Ran { code: number; stdout: string; stderr: string }

// Runs a command with its arguments, no shell, and gives back its code and output; it never throws on a non-zero exit.
export function run(argv: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : undefined, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (error) => done({ code: 127, stdout, stderr: stderr + String(error) }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      child.stdin.on("error", () => {}); // a command that ends before reading all of it
      child.stdin.end(options.input);
    }
  });
}

// The same, through sh, for the commands a spec writes as one line.
export const sh = (line: string, cwd?: string) => run(["sh", "-c", line], { cwd });

// Throws with the command's own words when it failed.
export async function must(ran: Promise<Ran>, what: string): Promise<Ran> {
  const r = await ran;
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r;
}
