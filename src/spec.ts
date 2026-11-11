// A repo's spec: what the pool needs to make its pods and run its checks, one JSON file per repo in the pool's config
// folder (~/.config/pool/repos/<name>.json), so that a new machine takes a repo by dropping its file in.
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Spec {
  name: string;
  source: string; // the repo's checkout the pods are made from, such as ~/projects/genai/api
  copy: string[]; // what each pod takes from it that git does not hold, such as .env and vendor
  services?: { up: string; network: string }; // what the pods share, started in source, and the network they join
  pod: {
    image: string;
    command?: string[]; // what the container runs, for an image whose own command ends at once
    user?: string; // who the checks run as, for an image whose own user is root
    workdir: string; // where the pod's checkout sits in its container
    env: Record<string, string>; // {n} is the pod's number
    request: { memory: string; cpu: number }; // what a pod asks of the machine, as Kubernetes' requests
    make?: string; // run in source as a pod is made, such as creating its database
    drop?: string; // run in source as a pod is removed
  };
  install?: { lock: string; run: string }; // in the pod, when the lock file moved
  refresh?: string; // in the pod, when the code moved
  checks: { name: string; run: string }[];
  min: number;
  max: number;
}

const HOME = homedir();
export const CONFIG = process.env.POOL_CONFIG ?? join(HOME, ".config", "pool");
export const DATA = process.env.POOL_DATA ?? join(HOME, ".local", "share", "pool");

export const tilde = (path: string) => (path.startsWith("~/") ? join(HOME, path.slice(2)) : path);
// Fills a pod's number into a spec's line.
export const fill = (line: string, n: number) => line.replaceAll("{n}", String(n));

export async function load(name: string): Promise<Spec> {
  const file = join(CONFIG, "repos", `${name}.json`);
  const text = await readFile(file, "utf8").catch(() => {
    throw new Error(`no spec for ${name}: the pool reads it from ${file}`);
  });
  const spec = JSON.parse(text) as Spec;
  if (spec.name !== name) throw new Error(`${file} names itself ${spec.name}, not ${name}`);
  return { ...spec, source: tilde(spec.source) };
}

export async function all(): Promise<Spec[]> {
  const names = await readdir(join(CONFIG, "repos")).catch(() => [] as string[]);
  return Promise.all(names.filter((f) => f.endsWith(".json")).map((f) => load(f.slice(0, -5))));
}

// A size such as 900M or 1.5G, in bytes.
export function bytes(size: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(size.trim());
  if (!m) throw new Error(`not a size: ${size}`);
  return Number(m[1]) * 1024 ** " KMGT".indexOf((m[2] || " ").toUpperCase());
}
