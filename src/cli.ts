// pool's command line.
//
//   pool pod ls <repo>
//   pool pod make|start|stop|rm <repo> <n>
//   pool pod exec <repo> <n> <command>
import * as pods from "./pod.ts";
import * as specs from "./spec.ts";

const [what, verb, repo, nth, ...rest] = process.argv.slice(2);
const USAGE = "usage: pool pod ls <repo> | pool pod make|start|stop|rm <repo> <n> | pool pod exec <repo> <n> <command>";

async function main(): Promise<number> {
  if (what !== "pod" || !verb || !repo) return fail(USAGE);
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

main().then((code) => process.exit(code), (error) => {
  console.error(`pool: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
