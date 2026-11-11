// The machine as it is now: the memory free, the cores, and what each pod's container uses.
import { availableParallelism } from "node:os";
import { readFile } from "node:fs/promises";
import { run } from "./proc.ts";
import { bytes } from "./spec.ts";

// MemAvailable: what the kernel could give without swapping, page cache counted as free.
export async function memoryFree(): Promise<number> {
  const text = await readFile("/proc/meminfo", "utf8");
  return Number(/^MemAvailable:\s+(\d+) kB/m.exec(text)?.[1] ?? 0) * 1024;
}

export const cores = () => availableParallelism();

// Each named container's memory in bytes, from one `docker stats` call; a stopped one is left out.
export async function usage(containers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!containers.length) return out;
  const r = await run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}", ...containers]);
  for (const line of r.stdout.split("\n")) {
    const [name, use] = line.split("\t");
    const size = use?.split(" / ")[0];
    if (name && size) out.set(name, bytes(size.replace(/iB$/, "")));
  }
  return out;
}
