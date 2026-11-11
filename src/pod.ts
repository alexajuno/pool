// A pod: the repo's code checked out on its own (a git worktree of the spec's source, in the pool's data folder) and a
// container of the spec's image with that checkout mounted, joined to the services the pods share. The pool owns every
// pod; the source checkout and its own containers stay the user's.
//
//   none ─make→ stopped ─start→ running ─stop→ stopped ─remove→ none
//
// A stopped pod keeps its checkout, its installed packages and its database, so it starts again in seconds.
import { cp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { must, run, sh } from "./proc.ts";
import { DATA, fill, type Spec } from "./spec.ts";

export type State = "none" | "stopped" | "running";
export interface Pod { repo: string; n: number; state: State; dir: string; container: string }

export const dirOf = (spec: Spec, n: number) => join(DATA, "pods", `${spec.name}-${n}`);
export const containerOf = (spec: Spec, n: number) => `pool-${spec.name}-${n}`;

const exists = (path: string) => stat(path).then(() => true, () => false);

async function running(container: string): Promise<boolean | null> {
  const r = await run(["docker", "inspect", "-f", "{{.State.Running}}", container]);
  return r.code === 0 ? r.stdout.trim() === "true" : null; // null: no such container
}

export async function state(spec: Spec, n: number): Promise<State> {
  if (!(await exists(dirOf(spec, n)))) return "none";
  return (await running(containerOf(spec, n))) ? "running" : "stopped";
}

export async function get(spec: Spec, n: number): Promise<Pod> {
  return { repo: spec.name, n, state: await state(spec, n), dir: dirOf(spec, n), container: containerOf(spec, n) };
}

// The pods this machine holds for the repo: a checkout each, made or not yet removed.
export async function list(spec: Spec): Promise<Pod[]> {
  const r = await run(["git", "-C", spec.source, "worktree", "list", "--porcelain"]);
  const prefix = join(DATA, "pods", `${spec.name}-`);
  const ns = r.stdout.split("\n").filter((l) => l.startsWith(`worktree ${prefix}`)).map((l) => Number(l.slice(9 + prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  return Promise.all(ns.map((n) => get(spec, n)));
}

// The checkout, what git does not hold copied from the source (copy-on-write where the disk can), and the pod's own
// share of the services, such as its database.
export async function make(spec: Spec, n: number): Promise<Pod> {
  const dir = dirOf(spec, n);
  if (await exists(dir)) return get(spec, n);
  await must(run(["git", "-C", spec.source, "worktree", "add", "--detach", "--quiet", dir, "HEAD"]), `checking out pod ${n}`);
  try {
    for (const path of spec.copy) {
      const from = join(spec.source, path);
      if (await exists(from)) await must(run(["cp", "-a", "--reflink=auto", from, join(dir, path)]), `copying ${path}`);
    }
    await services(spec);
    if (spec.pod.make) await must(sh(fill(spec.pod.make, n), spec.source), `making pod ${n}’s share of the services`);
  } catch (error) {
    await run(["git", "-C", spec.source, "worktree", "remove", "--force", dir]);
    throw error;
  }
  return get(spec, n);
}

// The shared services up, when the network the pods join is missing.
async function services(spec: Spec) {
  if (!spec.services) return;
  if ((await run(["docker", "network", "inspect", spec.services.network])).code === 0) return;
  await must(sh(spec.services.up, spec.source), `starting ${spec.name}’s services`);
}

export async function start(spec: Spec, n: number): Promise<Pod> {
  const container = containerOf(spec, n);
  if ((await state(spec, n)) === "none") await make(spec, n);
  await services(spec);
  const now = await running(container);
  if (now === false) await must(run(["docker", "start", container]), `starting pod ${n}`);
  if (now === null) {
    const env = Object.entries(spec.pod.env).flatMap(([k, v]) => ["-e", `${k}=${fill(v, n)}`]);
    await must(run(["docker", "run", "-d", "--name", container,
      "--label", `pool.repo=${spec.name}`, "--label", `pool.pod=${n}`,
      ...(spec.services ? ["--network", spec.services.network] : []),
      // The checkout's .git names the repo's git folder by its path here, so the container sees it at that path too.
      "-v", `${dirOf(spec, n)}:${spec.pod.workdir}`, "-v", `${await gitDir(spec)}:${await gitDir(spec)}`, "-w", spec.pod.workdir, ...(spec.pod.user ? ["--user", spec.pod.user] : []),
      ...env, spec.pod.image, ...(spec.pod.command ?? [])]), `starting pod ${n}`);
  }
  return get(spec, n);
}

const gitDir = async (spec: Spec) =>
  (await must(run(["git", "-C", spec.source, "rev-parse", "--path-format=absolute", "--git-common-dir"]), `finding ${spec.name}’s git folder`)).stdout.trim();

export async function stop(spec: Spec, n: number): Promise<Pod> {
  if (await running(containerOf(spec, n))) await must(run(["docker", "stop", "-t", "10", containerOf(spec, n)]), `stopping pod ${n}`);
  return get(spec, n);
}

// The container, the pod's share of the services and its checkout, all gone.
export async function remove(spec: Spec, n: number): Promise<Pod> {
  await run(["docker", "rm", "-f", containerOf(spec, n)]);
  if (spec.pod.drop) await must(sh(fill(spec.pod.drop, n), spec.source), `dropping pod ${n}’s share of the services`);
  const dir = dirOf(spec, n);
  await run(["git", "-C", spec.source, "worktree", "remove", "--force", dir]);
  await rm(dir, { recursive: true, force: true });
  await run(["git", "-C", spec.source, "worktree", "prune"]);
  return get(spec, n);
}

// A command in the running pod, in its checkout, as the image's user.
export function exec(spec: Spec, n: number, line: string) {
  return run(["docker", "exec", "-i", containerOf(spec, n), "sh", "-c", line]);
}
