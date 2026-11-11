// The pool's HTTP API, on 127.0.0.1 only:
//
//   POST   /checks          {"worktree": "<path>", "callback": "<url>"?}   a check joins the line
//   GET    /checks                                                        the line, and the last results
//   GET    /checks/<id>                                                   one check, with its result once it ended
//   GET    /checks/<id>/log                                               its output as it runs
//   DELETE /checks/<id>                                                   out of the line, or stopped
//   GET    /status                                                        each repo's pods, and the machine's room
//   PATCH  /repos/<name>    {"min": 1, "max": 4}                          scale a repo
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import * as pool from "./pool.ts";
import * as runner from "./run.ts";

export async function serve() {
  const cfg = await pool.start();
  createServer((req, res) => void handle(req, res)).listen(cfg.port, "127.0.0.1", () => console.log(`pool: listening on http://127.0.0.1:${cfg.port}`));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 1));
  };
  try {
    const url = new URL(req.url ?? "/", "http://pool");
    const parts = url.pathname.split("/").filter(Boolean);
    const body = req.method === "POST" || req.method === "PATCH" ? await json(req) : {};
    if (req.method === "POST" && url.pathname === "/checks") {
      if (typeof body.worktree !== "string") return send(400, { detail: "worktree: the path of the worktree to check" });
      const c = await pool.ask(body.worktree, typeof body.callback === "string" ? body.callback : null);
      return send(201, c);
    }
    if (req.method === "GET" && url.pathname === "/checks") return send(200, pool.checks());
    if (req.method === "GET" && url.pathname === "/status") return send(200, await pool.status());
    if (parts[0] === "checks" && parts[1]) {
      const c = pool.find(parts[1]);
      if (!c) return send(404, { detail: `no check ${parts[1]}` });
      if (req.method === "GET" && parts[2] === "log") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(await readFile(runner.logOf(c.id), "utf8").catch(() => ""));
      }
      if (req.method === "GET") return send(200, c);
      if (req.method === "DELETE") return send(200, pool.cancel(c.id));
    }
    if (req.method === "PATCH" && parts[0] === "repos" && parts[1]) {
      const change = { min: num(body.min), max: num(body.max) };
      return send(200, await pool.scale(parts[1], change));
    }
    send(404, { detail: `no ${req.method} ${url.pathname}` });
  } catch (error) {
    if (error instanceof pool.Refused) return send(422, { detail: error.message });
    console.error("pool:", error);
    send(500, { detail: error instanceof Error ? error.message : String(error) });
  }
}

const num = (v: unknown) => (v === undefined ? undefined : Number(v));

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
