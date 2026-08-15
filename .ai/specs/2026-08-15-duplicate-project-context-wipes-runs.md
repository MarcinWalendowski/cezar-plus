# Two contexts over one project root wipe that project's run history

> **Status:** **Reported, not fixed.** Found 2026-08-15 during the runtime E2E for
> `2026-08-15-autonomous-implementation-continuation.md`, which is unrelated to it — that E2E was
> re-run on a neutral boot repo to avoid this, and passed. Written up now because the failure
> **destroys data silently** and the next person to hit it will read it as "cezar lost my tasks".
> **Date:** 2026-08-15

## TLDR

Boot the server on a repo (`cezar serve --repo X`) and *also* register that same `X` through
`POST /api/v1/projects`, and cezar ends up with **two project contexts over one root**, each with
its own `RunStore` instance over the same `runs.json`. They do not share state. The stale/empty one
wins the last write, and the run history is gone.

## Problem

Observed, in this order, on a clean `CEZ_HOME`:

1. Booted with `--repo projA`. `GET /api/v1/projects` listed **only** `projb` — the boot repo was
   not in the registry.
2. Registered `projA` via `POST /api/v1/projects` → id `proja`, root = the same directory.
3. Drove the note pipeline. It created two real runs in `proja` and recorded their ids on the note.
4. `GET /api/v1/p/proja/runs` returned `[]` — **while `projA/.ai/cezar/runs.json` on disk held both
   runs.** The endpoint is not degrading on a bad id: an unknown id 404s (`unknown project:
   totally-made-up`), so `proja` resolved and genuinely reported zero.
5. Restarted the server. `runs.json` was now **2 bytes — `[]`**. The records were destroyed.

So the API read one store while the note pipeline wrote another, and the empty one flushed last.

The same scenario on a **neutral** boot repo (boot `projC`, register `projA`/`projB`) behaves
correctly: runs appear through `GET /p/:id/runs` and through `GET /workspace/runs`, and they
survive a restart intact. That is the control, and it is what isolates the cause to the duplication
rather than to restarting, to flushing, or to the note pipeline.

## Why it matters more than it looks

- **Silent.** No error, no warning. A `200 []` from the runs endpoint reads as "no tasks yet".
- **Destructive.** It is not a display bug — the file is truncated.
- **Reachable by an ordinary action.** Boot in a repo, then use "add project" and pick that same
  repo. Nothing refuses it: registration returned a normal `201`-shaped body with a fresh slug.

## Where to look

- `packages/cezar/src/workspace/projects.ts` — `registerProject` / `allocateProjectSlug`. Does
  registration dedupe on `root` (realpath-normalised), and what should it return when the root is
  already the boot project?
- `packages/cezar/src/server/project-context.ts` — context keying. The boot context and a registry
  context for the same root must resolve to **one** `ProjectContext`, or one `RunStore` per root
  must be enforced at the store layer.
- `packages/cezar/src/runs/store.ts` — whether `RunStore.open` should be an identity map per data
  dir rather than a constructor, so a second `open()` of the same directory cannot produce a second
  in-memory copy that can overwrite the first.

## Verification

Each guard with the mutation that must turn it red.

| Guard | Mutation that must turn it red |
|---|---|
| Registering a root that is already the boot project returns the **existing** project, and the registry gains no second entry for that root | Allocate a fresh slug for the same root |
| `RunStore.open` twice on one data dir yields instances that observe each other's writes (or the same instance) | Return two independent instances |
| A run created through context A is visible via `GET /p/:id/runs` on context B for the same root | Give each context its own store |
| The record count in `runs.json` never decreases across a server restart with no archive/delete call | Flush an empty in-memory list over a non-empty file |

The last one is the one that actually catches the data loss, and it must assert on the **file**,
not on an API read — an API read is exactly what looked fine while the file was being truncated.

Runtime repro: the five numbered steps above, ending by reading `runs.json` with `wc -c`.
