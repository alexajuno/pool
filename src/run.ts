// One check in one pod: the worktree's code as it stands, uncommitted and new files included, checked out in the
// pod, the packages brought up to its lock file, each of the spec's checks run in the container, and what they wrote
// (such as Pint's fixes) applied back to the worktree.
//
// The code goes onto the pod's own branch, pool/<repo>-<n>, each snapshot a child of the last and of the worktree's
// HEAD, never a detached HEAD: Pest's test impact analysis keeps no record on a detached HEAD, and reads one only when
// the commit it was made on is an ancestor of HEAD (desk's bin/stack-run found both on 9 Nov). So a pod's next check
// runs only the tests the code that moved touches.
//
// The log keeps the lines desk's bin/stack-run printed: "== <name>" before each check, "== <name>: passed" or
// "failed" after it, then "== written back to the worktree:" and the files, or "== kept as a patch: <path>".
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pods from "./pod.ts";
import { must, run } from "./proc.ts";
import { DATA, type Spec } from "./spec.ts";

export interface Result {
  code: number; // 0 all passed, 1 one failed, 2 no check could run
  head: string | null; // the worktree's HEAD the snapshot sits on
  checks: { name: string; passed: boolean }[];
  written: string[]; // files the checks changed, now changed in the worktree too
  patch: string | null; // or the patch holding them, when the worktree moved under them
  error: string | null; // why no check ran
  log: string;
}

export const logOf = (id: string) => join(DATA, "logs", `${id}.log`);
const stateOf = (spec: Spec, n: number) => join(DATA, "state", `${spec.name}-${n}.json`);
const branchOf = (spec: Spec, n: number) => `pool/${spec.name}-${n}`;

// The repo a worktree belongs to: the spec whose source shares its git folder.
export async function commonDir(path: string): Promise<string | null> {
  const r = await run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function check(spec: Spec, n: number, worktree: string, id: string, signal: AbortSignal): Promise<Result> {
  await mkdir(join(DATA, "logs"), { recursive: true });
  const log = logOf(id);
  const fd = openSync(log, "w");
  const say = (line: string) => writeSync(fd, `${line}\n`);
  const result: Result = { code: 2, head: null, checks: [], written: [], patch: null, error: null, log };
  try {
    const pod = pods.dirOf(spec, n);
    result.head = (await run(["git", "-C", worktree, "rev-parse", "HEAD"])).stdout.trim() || null;
    const snapshot = await snap(spec, n, worktree);
    await must(run(["git", "-C", pod, "reset", "-q", "--hard"]), "clearing the pod");
    await must(run(["git", "-C", pod, "clean", "-qfd"]), "clearing the pod");
    await must(run(["git", "-C", pod, "checkout", "-q", "-B", branchOf(spec, n), snapshot]), "checking the snapshot out in the pod");
    say(`pool: ${worktree}${result.head ? ` at ${result.head.slice(0, 7)}` : ""} in pod ${spec.name}-${n}`);
    await install(spec, n, fd);
    const base = await settled(pod); // what the install wrote is not the checks' to give back
    result.code = 0;
    for (const c of spec.checks) {
      if (signal.aborted) throw new Error("stopped");
      say(`== ${c.name}`);
      const passed = (await inPod(spec, n, c.run, fd, signal)) === 0;
      say(`\n== ${c.name}: ${passed ? "passed" : "failed"}`);
      result.checks.push({ name: c.name, passed });
      if (!passed) result.code = 1;
    }
    await giveBack(spec, n, worktree, base, id, result, say);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.code = 2;
    say(`pool: ${result.error}`);
  } finally {
    closeSync(fd);
  }
  return result;
}

// A commit of the worktree as it stands, made through a scratch index so the worktree's own index stays as it is.
async function snap(spec: Spec, n: number, worktree: string): Promise<string> {
  const index = join(tmpdir(), `pool-index-${process.pid}-${Date.now()}`);
  const own = (await must(run(["git", "-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "index"]), "finding the worktree’s index")).stdout.trim();
  await writeFile(index, await readFile(own));
  try {
    const env = { GIT_INDEX_FILE: index };
    await must(run(["git", "-C", worktree, "add", "-A"], { env }), "snapshotting the worktree");
    const tree = (await must(run(["git", "-C", worktree, "write-tree"], { env }), "snapshotting the worktree")).stdout.trim();
    const last = (await run(["git", "-C", worktree, "rev-parse", "-q", "--verify", `refs/heads/${branchOf(spec, n)}`])).stdout.trim();
    const parents = [...(last ? ["-p", last] : []), "-p", "HEAD"];
    return (await must(run(["git", "-C", worktree, "commit-tree", tree, ...parents, "-m", `pool snapshot of ${worktree}`]), "snapshotting the worktree")).stdout.trim();
  } finally {
    await rm(index, { force: true });
  }
}

// The packages follow the lock file, and the spec's refresh (genai-api's autoloader) follows the code.
async function install(spec: Spec, n: number, fd: number) {
  const pod = pods.dirOf(spec, n);
  const file = stateOf(spec, n);
  const state = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as { lock?: string; tree?: string };
  const tree = (await run(["git", "-C", pod, "rev-parse", "HEAD^{tree}"])).stdout.trim();
  const lock = spec.install ? await readFile(join(pod, spec.install.lock)).then((b) => createHash("sha1").update(b).digest("hex"), () => "") : "";
  if (spec.install && lock !== state.lock) {
    writeSync(fd, `pool: ${spec.install.lock} moved: installing in the pod.\n`);
    if ((await inPod(spec, n, spec.install.run, fd)) !== 0) throw new Error("installing the packages failed, so no check ran");
  } else if (spec.refresh && tree !== state.tree) {
    if ((await inPod(spec, n, spec.refresh, fd)) !== 0) throw new Error("refreshing the pod failed, so no check ran");
  }
  await mkdir(join(DATA, "state"), { recursive: true });
  await writeFile(file, JSON.stringify({ lock, tree }));
}

// The pod's files as a tree, as they stand.
async function settled(pod: string): Promise<string> {
  await must(run(["git", "-C", pod, "add", "-A"]), "reading the pod’s files");
  return (await must(run(["git", "-C", pod, "write-tree"]), "reading the pod’s files")).stdout.trim();
}

// What the checks wrote in the pod since base goes back to the worktree, or into a patch when the session edited those
// lines since. What the install wrote before base, such as assets a package's scripts publish, stays in the pod.
async function giveBack(spec: Spec, n: number, worktree: string, base: string, id: string, result: Result, say: (l: string) => void) {
  const pod = pods.dirOf(spec, n);
  const after = await settled(pod);
  if (after === base) return;
  const files = (await run(["git", "-C", pod, "diff", "--name-only", base, after])).stdout.trim().split("\n").filter(Boolean);
  const patch = (await run(["git", "-C", pod, "diff", "--binary", base, after])).stdout;
  if ((await run(["git", "-C", worktree, "apply", "--binary"], { input: patch })).code === 0) {
    result.written = files;
    say("== written back to the worktree:");
    for (const f of files) say(f);
  } else {
    await mkdir(join(DATA, "patches"), { recursive: true });
    result.patch = join(DATA, "patches", `${id}.patch`);
    await writeFile(result.patch, patch);
    say(`== kept as a patch: ${result.patch}`);
  }
}

// A line run in the pod, its output into the log; aborting kills the container's processes by restarting it.
function inPod(spec: Spec, n: number, line: string, fd: number, signal?: AbortSignal): Promise<number> {
  return new Promise((done) => {
    const child = spawn("docker", ["exec", "-i", pods.containerOf(spec, n), "sh", "-c", line], { stdio: ["ignore", fd, fd] });
    const stop = () => void run(["docker", "restart", "-t", "2", pods.containerOf(spec, n)]);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => done(127));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      done(code ?? 1);
    });
  });
}
