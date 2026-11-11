# pool

Runs repos’ checks (lint, static analysis, tests) for many coding sessions at once on one machine, in pods that scale with the queue and with the room the machine has.

A repo joins by its spec, `~/.config/pool/repos/<name>.json` (genai-api's is in `examples/`): how to make a pod, what each pod asks of the machine, and its checks. A pod is the repo's code checked out on its own, with a container of the repo's image on it, joined to the services the pods share; the pool owns every pod, and the repo's own checkout stays yours.

    pool pod ls <repo>
    pool pod make|start|stop|rm <repo> <n>
    pool pod exec <repo> <n> <command>

Node 24 runs the TypeScript as it is; `pnpm check` checks the types.
