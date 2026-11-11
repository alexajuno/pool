// The pool's own settings for this machine, ~/.config/pool/pool.json, each with its default.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bytes, CONFIG } from "./spec.ts";

export interface Config {
  port: number; // the HTTP API, on 127.0.0.1
  floor: number; // bytes of memory the pool always leaves free for the user
  idle: number; // seconds a pod sits idle before it stops, when more than min run
}

export async function load(): Promise<Config> {
  const raw = JSON.parse(await readFile(join(CONFIG, "pool.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
  return {
    port: Number(raw.port ?? 7790),
    floor: bytes(String(raw.floor ?? "4G")),
    idle: Number(raw.idle ?? 300),
  };
}
