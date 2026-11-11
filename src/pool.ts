// The queue and the scaler, shaped like Kubernetes' HPA on a queue, as KEDA scales on one: each repo wants as many
// pods busy as it has checks running or waiting, between its spec's min and max, and gets them only while the
// machine has room. Room is the memory free above the user's floor, less what the busy pods may still grow into, and
// the cores the busy pods' requests leave. One check always runs, room or not, as one stack did before the pool.
//
// A check waits in line until a pod is free; a pod idle past the config's idle stops when more than min run, and
// keeps its checkout and packages for a fast start; a pod numbered above max goes once it is idle. What a pod costs
// is its spec's request until the pool has seen it run: then the peak of its last checks, sampled every few seconds.
//
// The line and the last results live in state.json, so a restart of the pool keeps the line; a check that ran
// through a restart runs again from the start, its pod restarted to end what it left running.
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as config from "./config.ts";
import * as node from "./node.ts";
import * as pods from "./pod.ts";
import { run } from "./proc.ts";
import * as runner from "./run.ts";
import * as specs from "./spec.ts";
import { bytes, DATA, type Spec } from "./spec.ts";

export interface Check {
  id: string;
  repo: string;
  worktree: string;
  callback: string | null; // a URL the result is POSTed to as it ends
  asked: number;
  started: number | null;
  pod: number | null;
  why: string | null; // why it still waits
  result?: runner.Result & { seconds: number };
}

const TICK = 5_000; // ms between looks, besides the ones each event brings
const PEAKS = 5; // a pod's cost is the highest of this many last peaks
const KEPT = 200; // finished checks kept for GET

let line: Check[] = [];
let done: Check[] = [];
let peaks: Record<string, number[]> = {}; // per repo
const aborts = new Map<string, AbortController>();
const sampled = new Map<string, { now: number; peak: number }>(); // per check id, its pod's memory
const idleSince = new Map<string, number>(); // per container
const starting = new Set<string>(); // containers being made or started
let cfg: config.Config;

const file = () => join(DATA, "state.json");
const now = () => Date.now() / 1000;

// One write at a time, each of the state as it is when its turn comes: two at once raced over the same temporary file.
let saving: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  saving = saving.then(async () => {
    await mkdir(DATA, { recursive: true });
    await writeFile(`${file()}.tmp`, JSON.stringify({ line, done, peaks }, null, 1));
    await rename(`${file()}.tmp`, file());
  }).catch((error) => console.error("pool: saving the state", error));
  return saving;
}

export async function start() {
  cfg = await config.load();
  const saved = JSON.parse(await readFile(file(), "utf8").catch(() => "{}")) as { line?: Check[]; done?: Check[]; peaks?: typeof peaks };
  [line, done, peaks] = [saved.line ?? [], saved.done ?? [], saved.peaks ?? {}];
  for (const c of line) {
    if (c.started === null || c.pod === null) continue;
    const spec = await specs.load(c.repo).catch(() => null);
    if (spec) await run(["docker", "restart", "-t", "2", pods.containerOf(spec, c.pod)]);
    Object.assign(c, { started: null, pod: null });
  }
  await save();
  setInterval(() => void look(), TICK);
  void look();
  return cfg;
}

// A check of a worktree joins the line. One already waiting for the same worktree stands for it, since it will read
// the worktree as it is when it starts.
export async function ask(worktree: string, callback: string | null): Promise<Check> {
  const repo = await repoOf(worktree);
  const waiting = line.find((c) => c.worktree === worktree && c.started === null);
  if (waiting) {
    if (callback) waiting.callback = callback;
    return waiting;
  }
  const c: Check = { id: randomUUID().slice(0, 8), repo: repo.name, worktree, callback, asked: now(), started: null, pod: null, why: null };
  line.push(c);
  await save();
  await look();
  return c;
}

async function repoOf(worktree: string): Promise<Spec> {
  const common = await runner.commonDir(worktree);
  if (!common) throw new Refused(`${worktree} is not a git checkout`);
  for (const spec of await specs.all()) if ((await runner.commonDir(spec.source)) === common) {
    if (spec.source === worktree) throw new Refused(`${worktree} is ${spec.name}’s own checkout: ask from a worktree`);
    return spec;
  }
  throw new Refused(`no spec covers ${worktree}: add one to ${join(specs.CONFIG, "repos")}`);
}

export class Refused extends Error {}

export function cancel(id: string): Check | null {
  const c = line.find((x) => x.id === id);
  if (!c) return null;
  if (c.started === null) {
    line = line.filter((x) => x !== c);
    void save();
  } else aborts.get(id)?.abort();
  return c;
}

export const find = (id: string) => line.find((c) => c.id === id) ?? done.find((c) => c.id === id) ?? null;
export const checks = () => ({ line, done: done.slice(-20) });

// A repo's min and max, written into its spec, for `pool scale`.
export async function scale(name: string, change: { min?: number; max?: number }) {
  const spec = await specs.load(name);
  const min = change.min ?? spec.min, max = change.max ?? spec.max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) throw new Refused(`min ${min} and max ${max}: need 0 ≤ min ≤ max, max ≥ 1`);
  const path = join(specs.CONFIG, "repos", `${name}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify({ ...raw, min, max }, null, 2)}\n`);
  void look();
  return { min, max };
}

const cost = (spec: Spec) => Math.max(bytes(spec.pod.request.memory), ...(peaks[spec.name] ?? []));

// The room the machine has for one more busy pod of this spec, or why not.
async function room(spec: Spec, all: Map<string, Spec>): Promise<string | null> {
  const busy = line.filter((c) => c.started !== null);
  if (!busy.length) return null;
  let memory = (await node.memoryFree()) - cfg.floor;
  let cpu = node.cores();
  for (const c of busy) {
    const s = all.get(c.repo);
    if (!s) continue;
    memory -= Math.max(0, cost(s) - (sampled.get(c.id)?.now ?? 0)); // what it may still grow into
    cpu -= s.pod.request.cpu;
  }
  for (const name of starting) memory -= cost(all.get(name.replace(/^pool-|-\d+$/g, "")) ?? spec);
  if (memory < cost(spec)) return `memory: ${gb(Math.max(0, memory))} free above the ${gb(cfg.floor)} floor, a pod needs ${gb(cost(spec))}`;
  if (cpu < spec.pod.request.cpu) return `cores: ${Math.max(0, cpu)} free, a pod asks ${spec.pod.request.cpu}`;
  return null;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

let looking = false, again = false;

// One look over every repo: give waiting checks free pods, start or make pods where there is room, stop idle ones.
export async function look() {
  if (looking) return void (again = true);
  looking = true;
  try {
    do {
      again = false;
      await sample();
      const all = new Map((await specs.all()).map((s) => [s.name, s]));
      for (const spec of all.values()) await lookAt(spec, all);
    } while (again);
  } catch (error) {
    console.error("pool: look", error);
  } finally {
    looking = false;
  }
}

async function lookAt(spec: Spec, all: Map<string, Spec>) {
  const have = await pods.list(spec);
  const busyPods = new Set(line.filter((c) => c.repo === spec.name && c.pod !== null).map((c) => c.pod!));
  for (const c of line.filter((x) => x.repo === spec.name && x.started === null)) {
    const idle = have.find((p) => p.state === "running" && !busyPods.has(p.n) && p.n <= spec.max && !starting.has(p.container));
    let pod = idle?.n ?? null;
    if (pod === null) {
      const why = await room(spec, all);
      const stopped = have.find((p) => p.state === "stopped" && p.n <= spec.max && !starting.has(p.container));
      const free = Array.from({ length: spec.max }, (_, i) => i + 1).find((n) => !have.some((p) => p.n === n));
      const next = stopped?.n ?? free ?? null;
      if (why || next === null) {
        c.why = why ?? `max: all ${spec.max} pods busy`;
        continue;
      }
      pod = next;
      await up(spec, pod);
      have.splice(0, have.length, ...(await pods.list(spec)));
      if ((await pods.state(spec, pod)) !== "running") continue;
    }
    busyPods.add(pod);
    void go(spec, c, pod);
  }
  // Pods to keep warm, to stop, or to remove.
  const t = now();
  const running = have.filter((p) => p.state === "running");
  for (const p of have) {
    if (busyPods.has(p.n) || starting.has(p.container)) {
      idleSince.delete(p.container);
      continue;
    }
    if (p.n > spec.max) {
      await pods.remove(spec, p.n);
      continue;
    }
    if (p.state !== "running") continue;
    const since = idleSince.get(p.container) ?? t;
    idleSince.set(p.container, since);
    if (t - since > cfg.idle && running.length > spec.min) {
      await pods.stop(spec, p.n);
      running.splice(running.indexOf(p), 1);
      idleSince.delete(p.container);
    }
  }
  if (running.length < spec.min && !(await room(spec, all))) {
    const n = Array.from({ length: spec.max }, (_, i) => i + 1).find((k) => !running.some((p) => p.n === k));
    if (n !== undefined) await up(spec, n);
  }
}

async function up(spec: Spec, n: number) {
  const container = pods.containerOf(spec, n);
  starting.add(container);
  try {
    await pods.start(spec, n);
  } catch (error) {
    console.error(`pool: pod ${spec.name}-${n} did not start:`, error);
  } finally {
    starting.delete(container);
  }
}

async function go(spec: Spec, c: Check, n: number) {
  Object.assign(c, { started: now(), pod: n, why: null });
  await save();
  const abort = new AbortController();
  aborts.set(c.id, abort);
  const result = await runner.check(spec, n, c.worktree, c.id, abort.signal);
  aborts.delete(c.id);
  const peak = sampled.get(c.id)?.peak;
  sampled.delete(c.id);
  if (peak && !result.error) peaks[spec.name] = [...(peaks[spec.name] ?? []), peak].slice(-PEAKS);
  c.result = { ...result, seconds: Math.round(now() - c.started!) };
  line = line.filter((x) => x !== c);
  done = [...done, c].slice(-KEPT);
  await save();
  if (c.callback) await tell(c);
  void look();
}

async function tell(c: Check) {
  try {
    const r = await fetch(c.callback!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) });
    if (!r.ok) console.error(`pool: ${c.callback} answered ${r.status} for ${c.id}`);
  } catch (error) {
    console.error(`pool: could not tell ${c.callback} about ${c.id}:`, error);
  }
}

// The busy pods' memory now, and each check's peak.
async function sample() {
  const busy = line.filter((c) => c.started !== null && c.pod !== null);
  if (!busy.length) return;
  const use = await node.usage(busy.map((c) => `pool-${c.repo}-${c.pod}`));
  for (const c of busy) {
    const m = use.get(`pool-${c.repo}-${c.pod}`);
    if (m === undefined) continue;
    const s = sampled.get(c.id);
    sampled.set(c.id, { now: m, peak: Math.max(m, s?.peak ?? 0) });
  }
}

// Each repo's pods with what they run, and the room the machine has, for `pool status`.
export async function status() {
  const all = await specs.all();
  const repos = [];
  for (const spec of all) {
    const ps = await pods.list(spec);
    repos.push({
      repo: spec.name, min: spec.min, max: spec.max, cost: gb(cost(spec)),
      pods: ps.map((p) => ({ n: p.n, state: p.state, check: line.find((c) => c.repo === spec.name && c.pod === p.n)?.id ?? null })),
      waiting: line.filter((c) => c.repo === spec.name && c.started === null).map((c) => ({ id: c.id, worktree: c.worktree, why: c.why })),
    });
  }
  return { memoryFree: gb(await node.memoryFree()), floor: gb(cfg.floor), cores: node.cores(), repos };
}
