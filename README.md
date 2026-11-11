# pool

Runs repos’ checks (lint, static analysis, tests) for many coding sessions at once on one machine, in pods that scale with the queue and with the room the machine has.

A repo joins by its spec, `~/.config/pool/repos/<name>.json` (genai-api's is in `examples/`): how to make a pod, what each pod asks of the machine, and its checks. A pod is the repo's code checked out on its own, with a container of the repo's image on it, joined to the services the pods share; the pool owns every pod, and the repo's own checkout stays yours.

    pool serve                                       the daemon, on 127.0.0.1:7790
    pool check <worktree> [--wait] [--callback <url>]
    pool status
    pool scale <repo> [--min <n>] [--max <n>]
    pool pod ls <repo>
    pool pod make|start|stop|rm <repo> <n>
    pool pod exec <repo> <n> <command>

A check waits in line until a pod is free. Each repo gets as many busy pods as it has checks, between its min and max, while the machine has room: memory free above a floor kept for you (4 GB), less what busy pods may still grow into, and the cores their requests leave. A pod idle for 5 minutes stops when more than min run, and keeps its checkout and packages. `~/.config/pool/pool.json` changes the port, the floor and the idle time. The HTTP API is in `src/server.ts`.

On a new machine: clone this repo, `cp systemd/pool.service ~/.config/systemd/user/ && systemctl --user enable --now pool`, and drop each repo's spec in.

Node 24 runs the TypeScript as it is; `pnpm check` checks the types.
