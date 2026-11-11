// pool's command line.
//
//   pool serve                                   the daemon (pool.service runs it)
//   pool check <worktree> [--wait] [--callback <url>]
//   pool status
//   pool scale <repo> [--min <n>] [--max <n>]
//   pool pod ls <repo>
//   pool pod make|start|stop|rm <repo> <n>
//   pool pod exec <repo> <n> <command>
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as config from "./config.ts";
import * as pods from "./pod.ts";
import { serve } from "./server.ts";
import * as specs from "./spec.ts";

const USAGE = `usage:
  pool serve
  pool check <worktree> [--wait] [--callback <url>]
  pool status
  pool scale <repo> [--min <n>] [--max <n>]
  pool pod ls <repo> | pool pod make|start|stop|rm <repo> <n> | pool pod exec <repo> <n> <command>`;

async function main(): Promise<number> {
  const [what, ...rest] = process.argv.slice(2);
  if (what === "serve") {
    await serve();
    return -1; // keeps running
  }
  if (what === "pod") return pod(rest);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    wait: { type: "boolean" }, callback: { type: "string" }, min: { type: "string" }, max: { type: "string" },
  } });
  const api = `http://127.0.0.1:${(await config.load()).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${api}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .catch(() => { throw new Error(`the pool does not answer on ${api}: start it with pool serve, or systemctl --user start pool`); });
    const data = await r.json() as Record<string, unknown>;
    if (!r.ok) throw new Error(String(data.detail ?? r.status));
    return data;
  };
  if (what === "check" && positionals[0]) {
    let c = await call("POST", "/checks", { worktree: resolve(positionals[0]), callback: values.callback });
    console.log(`check ${c.id}: ${c.started ? `running in pod ${c.repo}-${c.pod}` : `waiting${c.why ? ` (${c.why})` : ""}`}`);
    if (!values.wait) return 0;
    while (!c.result) {
      await new Promise((wake) => setTimeout(wake, 3000));
      c = await call("GET", `/checks/${c.id}`);
    }
    const result = c.result as { code: number; checks: { name: string; passed: boolean }[]; seconds: number; log: string; error: string | null };
    for (const k of result.checks) console.log(`${k.passed ? "passed" : "FAILED"}  ${k.name}`);
    if (result.error) console.log(`error: ${result.error}`);
    console.log(`${result.seconds} s, log: ${result.log}`);
    return result.code;
  }
  if (what === "status") {
    console.log(JSON.stringify(await call("GET", "/status"), null, 1));
    return 0;
  }
  if (what === "scale" && positionals[0]) {
    const change = { min: values.min === undefined ? undefined : Number(values.min), max: values.max === undefined ? undefined : Number(values.max) };
    const r = await call("PATCH", `/repos/${positionals[0]}`, change);
    console.log(`${positionals[0]}: min ${r.min}, max ${r.max}`);
    return 0;
  }
  return fail(USAGE);
}

async function pod([verb, repo, nth, ...rest]: string[]): Promise<number> {
  if (!verb || !repo) return fail(USAGE);
  const spec = await specs.load(repo);
  if (verb === "ls") {
    for (const p of await pods.list(spec)) console.log(`${p.n}\t${p.state}\t${p.container}\t${p.dir}`);
    return 0;
  }
  const n = Number(nth);
  if (!Number.isInteger(n) || n < 1) return fail(USAGE);
  if (verb === "exec") {
    const r = await pods.exec(spec, n, rest.join(" "));
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    return r.code;
  }
  const act = { make: pods.make, start: pods.start, stop: pods.stop, rm: pods.remove }[verb];
  if (!act) return fail(USAGE);
  const p = await act(spec, n);
  console.log(`${p.n}\t${p.state}\t${p.container}\t${p.dir}`);
  return 0;
}

function fail(message: string) {
  console.error(message);
  return 64;
}

main().then((code) => code >= 0 && process.exit(code), (error) => {
  console.error(`pool: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
