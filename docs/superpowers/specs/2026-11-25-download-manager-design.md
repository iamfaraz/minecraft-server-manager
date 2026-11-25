# Global download manager — design

Date: 2026-11-25
Related: `2026-11-25-modpack-servers-design.md` (built after this; modpack installs use it).

## Intent

One place in the app that shows everything being downloaded, when it's happening, for which server, how fast,
and lets the admin cancel or retry. It also fixes reliability gaps in how the app downloads today.

## Goals

- Every file download the app does goes through one backend module.
- A top-bar indicator (active count) opening a downloads panel: file, owner (server name / "System"), size,
  progress, speed, ETA, state; recent finished/failed entries below.
- **Cancel** an active download (or a whole task, e.g. a server install). **Retry** a failed one.
- Reliability: stall timeout, automatic retries with resume, dedupe of identical concurrent downloads, cleanup of
  partial files, verification when a hash is known.

## Non-goals

- Pause/resume from the UI.
- Tracking uploads to the app (the browser already shows upload progress).
- Tracking tiny lookups: API JSON calls (`fetchJson`), item icons, skins.
- Persisting history across app restarts.

## What gets tracked (current download sites)

| Site | File(s) |
|---|---|
| `install/java.ts` | Vanilla/Paper/Purpur/Fabric jars, Forge/NeoForge installers, Geyser, Floodgate, Fabric API |
| Forge/NeoForge installer child process | its own library downloads → one **indeterminate** entry ("Forge installer: downloading libraries"); cancel kills the process |
| `install/bedrock.ts` | Bedrock Dedicated Server zip |
| `versions/runtime.ts` | Adoptium Java runtimes |
| `addons.ts` | Modrinth mod/plugin installs |
| `modupdates.ts` | mod updates, client-pack installer |
| `playit.ts`, `broadcaster.ts` | playit agent, MCXboxBroadcast jar |
| (new) `modpacks.ts` | `.mrpack` files and all pack files |

## Approaches

1. **Central module replacing `downloadTo`/`downloadCached` internals (chosen).** Callers keep their call shape and
   pass an optional context (owner, task, expected hash, signal). Every site benefits at once.
2. Wrap each call site separately with tracking. More churn, easy to miss a site, reliability fixes duplicated.
   Rejected.

## Design

### Backend: `server/src/downloads.ts`

- `DownloadJob`: `id`, `url`, `label` (file name), `owner` (`{ serverId?, kind: 'server-install' | 'addon' |
  'mod-update' | 'modpack' | 'runtime' | 'system' }`), `taskId?`, `bytesDone`, `bytesTotal | null`,
  `speedBps`, `state: 'queued' | 'active' | 'verifying' | 'done' | 'failed' | 'cancelled'`, `error?`, `attempt`,
  `startedAt`, `finishedAt?`, `indeterminate?`.
- **Tasks** group jobs (e.g. "Install Paper 1.21.4 for *Survival*"). A task has `id`, `label`, `serverId?`,
  optional `retry()` callback, and an `AbortController`. Cancelling a task aborts all its jobs and its child
  processes; the owning operation sees a `CancelledError`.
- `downloadTo(url, dest, onProgress?, ctx?)` and `downloadCached(url, onProgress?, ext?, ctx?)` keep their
  signatures (ctx optional) so existing callers keep working; callers are updated to pass ctx.
- **Concurrency**: global limit of 6 active downloads; extra jobs queue (shown as "queued").
- **Stall timeout**: abort an attempt if no bytes arrive for 60 s (and a 30 s connect timeout).
- **Retries**: up to 3 attempts with backoff (2 s, 8 s, 20 s) on network errors, stalls and 5xx. Resume with
  `Range` when the first response advertised `Accept-Ranges: bytes` and the `.part` exists; otherwise restart.
  4xx (other than 408/429) fails immediately.
- **Dedupe**: an in-flight map keyed by destination path; a second request for the same dest awaits the same job
  (fixes the shared-cache race when two servers install at once).
- **Verification**: when ctx carries `sha1`/`sha512`, verify after download (state `verifying`); mismatch deletes
  the file and counts as a failed attempt. `downloadCached` with a known hash re-verifies cached files before reuse.
  Without a hash, a completed download whose size ≠ `content-length` is treated as failed.
- **Cleanup**: `.part` removed on final failure/cancel; at app start, sweep stale `*.part` in the cache dir.
- **History**: in memory, last 100 finished jobs/tasks.
- **Events**: `download.changed` on the websocket bus (throttled ~300 ms per job; immediate on state change).
  Existing `server.progress` / `addon.progress` events stay as they are.
- **API**: `GET /api/downloads` (tasks + jobs, active and recent), `POST /api/downloads/tasks/:id/cancel`,
  `POST /api/downloads/:id/cancel` (single job — fails its task), `POST /api/downloads/tasks/:id/retry`,
  `DELETE /api/downloads/history`.

### Cancel / retry semantics

- Cancelling a server install: install stops, server shows state `error` with "Install cancelled"; the existing
  Reinstall action (and the task's Retry) runs it again. Cached files already finished are kept.
- Cancelling a mod install/update: that operation is rolled back as it already does on failure (`.new` file removed).
- Retry is offered on failed/cancelled tasks that registered a `retry()` (server install → reinstall; addon
  install; mod update; client pack; modpack install/update). Standalone system downloads (playit, broadcaster,
  runtime) retry by re-running their download.

### Web UI

- `components/layout/Shell.tsx`: top-bar download icon with a badge = active jobs; subtle animation while active.
- Click → panel (popover on desktop, full-screen sheet on mobile):

```
Downloads                                   Clear history
── Active ──────────────────────────────────────────────
Install Fabric 1.21.1 · Survival                 [Cancel]
  fabric-server-launch.jar   ████████░░  82%  4.1 MB/s
  OpenJDK 21 runtime         queued
Modpack Cobblemon 1.6.1 · Cobble                 [Cancel]
  128 files · 61 / 128 · 210 MB / 410 MB   ███░░  2 failed, retrying
── Recent ──────────────────────────────────────────────
✓ Geyser-fabric.jar  · Survival  · 2 min ago
✕ sodium-0.6.jar     · Creative  · HTTP 404       [Retry]
```

- Tasks with many files (modpacks) collapse to a summary line, expandable to per-file rows.

## Left to the builder

- Exact UI component structure and styling within the existing look.
- Whether queued/active ordering is FIFO or per-task fair.
- Test approach (a local HTTP server fixture for stall/resume/retry is suggested).
