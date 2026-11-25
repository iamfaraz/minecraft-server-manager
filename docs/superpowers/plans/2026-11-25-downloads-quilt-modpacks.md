# Download Manager, Quilt and Modpack Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every file download through one tracked, cancellable, retrying download manager with a top-bar panel; add Quilt as a server type; let admins create and update servers from Modrinth modpacks (`.mrpack`) by upload, search or popular list, with a "How to join" card for players.

**Architecture:** A new `server/src/downloads.ts` owns all HTTP file transfers (queue, stall timeout, retry/resume, verification, dedupe, tasks with cancel/retry) and publishes `download.changed` on the existing bus; `util.ts` `downloadTo`/`downloadCached` delegate to it. Quilt is a seventh `JavaType` installed via the Quilt installer. Modpacks live under `server/src/modpacks/` as pure modules (parse, classify, client-only detection, update planning) plus I/O modules (store, Modrinth, install, update) that plug into `manager.create()` and `updates.ts`.

**Tech Stack:** Node 24, TypeScript, Fastify 5, adm-zip, React + TanStack Query + Tailwind (web). Tests: Node's built-in test runner through `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-11-25-download-manager-design.md` and `docs/superpowers/specs/2026-11-25-modpack-servers-design.md` (including its "Decisions from review" section, which overrides earlier rules in that doc).

## Global Constraints

- Download concurrency: max **6** active downloads globally; extras are `queued`.
- Stall timeout **60 s** without bytes; connect timeout **30 s**.
- Retries: up to **3 attempts** total, backoff **2 s, 8 s, 20 s** (tests may inject shorter delays); retry on network error, stall, 5xx, 408, 429; any other 4xx fails at once.
- Resume with `Range` only when the first response had `Accept-Ranges: bytes` and a `.part` exists.
- History: in memory, last **100** finished jobs/tasks; not persisted.
- `download.changed` throttled to ~**300 ms** per job; state changes publish immediately.
- Not tracked: `fetchJson`/`fetchText`, item icons, skins, uploads.
- Modpack create: default memory **4096 MB** in the wizard.
- Modrinth popular list: search `index=downloads`, facets `[["project_type:modpack"],["server_side:required","server_side:optional"]]`.
- Pack version default: newest `version_type === 'release'`.
- Join link format: `https://modrinth.com/modpack/<slug>/version/<versionNumber>`.
- Pre-update backup: `scope: 'full'`, label `pre-modpack-<old>→<new>`.
- Quilt loader meta: `https://meta.quiltmc.org/v3/versions/loader/<mc>`; installer: `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/<v>/quilt-installer-<v>.jar`; launch jar `quilt-server-launch.jar`; Modrinth loaders for Quilt `['quilt', 'fabric']`.
- Supported `.mrpack`: `formatVersion === 1`, `game === 'minecraft'`. CurseForge zips are rejected with a clear message.
- Never touch files outside the server root; reject absolute paths and `..` in pack paths and override entries.
- Don't commit to `main` without the user's go-ahead; work on branch `feat/downloads-modpacks`.

## Review Focus

1. **A cached file from before this change has no hash sidecar.** `downloadCached` must keep reusing it (no forced re-download) when no hash is given, and verify it when a hash is given. → test in Task 2 (`reuses legacy cache file without hash`).
2. **A pack whose `downloads[]` URL 404s but has a second mirror URL.** The installer should try the next URL before failing. → test in Task 11 (`falls back to second download URL`).
3. **An upload from a phone named `pack.zip`, or with no extension.** It must be accepted when it contains `modrinth.index.json`, and a CurseForge `manifest.json` zip must get the CurseForge message. → test in Task 8 (`accepts mrpack by content not extension`, `rejects curseforge zip with message`).
4. **App restart during an install leaves a `.part` file and a server stuck in `installing`.** The startup sweep removes `.part` files. The existing startup state recovery must not leave the server stuck. → test in Task 3 (`sweepPartials removes stale .part files`) plus a manual check in Task 4.
5. **Pack update when the server was running.** It must stop the server, apply, and start it again. On rollback it must also start again if it had been running. → test in Task 14 (`restarts server after update and after rollback`).

---

## Part A — Download manager

### Task 1: Test runner and HTTP fixture

**Files:**
- Modify: `server/package.json` (add `"test": "tsx --test 'src/**/*.test.ts'"`)
- Create: `server/src/test/httpFixture.ts`
- Test: `server/src/test/httpFixture.test.ts`

**Interfaces:**
- Produces: `startFixture(): Promise<{ url: string; close(): Promise<void>; hits: Record<string, number> }>`, serving:
  - `/ok/:size`: `size` deterministic bytes (byte i = i % 251), `Content-Length`, `Accept-Ranges: bytes`, and Range support.
  - `/stall/:size`: sends half, then never ends.
  - `/flaky/:n/:size`: returns 500 for the first `n` hits, then behaves like `/ok`.
  - `/drop/:size`: on the first hit, sends half and destroys the socket. Later hits honour Range.
  - `/status/:code`: an empty response with that code.
  - `/short/:size`: advertises `size` but sends `size - 10`.
  - `/slow/:size`: 1 KB every 50 ms.
- `fixtureBytes(size: number): Buffer`, the expected body for comparisons.

- [ ] **Step 1:** Write `httpFixture.test.ts`. `/ok/1000` returns exactly `fixtureBytes(1000)`. `Range: bytes=500-` returns 206 and the last 500 bytes. `/flaky/2/10` returns 500, 500, 200, and `hits['/flaky/2/10'] === 3`.
- [ ] **Step 2:** Run `cd server && npm test`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the fixture with `node:http` on port 0.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `test: add node test runner and HTTP fixture`.

### Task 2: Download core (`downloads.ts`)

**Files:**
- Create: `server/src/downloads.ts`
- Test: `server/src/downloads.test.ts`

**Interfaces:**
- Produces:
```ts
export type JobState = 'queued' | 'active' | 'verifying' | 'done' | 'failed' | 'cancelled';
export type OwnerKind = 'server-install' | 'addon' | 'mod-update' | 'modpack' | 'runtime' | 'system';
export interface DownloadCtx {
  taskId?: string; serverId?: string; kind?: OwnerKind; label?: string;
  sha1?: string; sha512?: string; expectedSize?: number; signal?: AbortSignal;
}
export interface DownloadJob { id: string; url: string; label: string; kind: OwnerKind; serverId?: string; taskId?: string;
  bytesDone: number; bytesTotal: number | null; speedBps: number; state: JobState; error?: string; attempt: number;
  indeterminate?: boolean; startedAt: string; finishedAt?: string; }
export class CancelledError extends Error {}
export interface ManagerOptions { concurrency?: number; stallMs?: number; connectMs?: number; backoffMs?: number[]; }
export class DownloadManager {
  constructor(opts?: ManagerOptions);
  download(url: string, dest: string, ctx?: DownloadCtx, onProgress?: Progress): Promise<void>;
  jobs(): DownloadJob[];
  on(event: 'change', fn: (job: DownloadJob) => void): void;
}
export const downloads: DownloadManager; // singleton with Global Constraints values
```
- Hashing helper: `export async function fileHash(file: string, algo: 'sha1' | 'sha512'): Promise<string>`.

Behaviour: write to `${dest}.part` and rename on success. Dedupe keys on `path.resolve(dest)`: a second caller gets the same promise. Size check uses `bytesTotal` (from `content-length`), or `ctx.expectedSize` when set. On final failure or cancel, delete `.part`. Keep the browser User-Agent from today's `downloadTo`. `onProgress` gets the same message format as today (`Downloading <label> (<done> / <total>)`).

- [ ] **Step 1:** Write tests, each using `new DownloadManager({ stallMs: 300, connectMs: 300, backoffMs: [10, 10, 10] })`:
  - `downloads a file and renames .part`: the result equals `fixtureBytes(5000)`, and no `.part` remains.
  - `retries 5xx then succeeds`: `/flaky/2/100` passes, with `attempt === 3` in `jobs()`.
  - `fails after 3 attempts`: `/flaky/5/100` rejects, and `hits === 3`.
  - `does not retry 404`: rejects, `hits === 1`, state `failed`, and the error contains `404`.
  - `aborts a stalled download and retries`: `/stall/1000` rejects after 3 attempts, within about 3 × 300 ms plus backoff.
  - `resumes with Range after a dropped connection`: `/drop/10000` passes, the content is correct, and the second request carried `Range: bytes=5000-`.
  - `fails on short body`: `/short/1000` rejects.
  - `verifies sha512 and fails on mismatch`: a wrong hash rejects and deletes the file. The right hash resolves.
  - `dedupes same dest`: two calls in parallel give `hits === 1` and both resolve.
  - `queues beyond concurrency`: with `concurrency: 2` and three `/slow` downloads, at most two are `active` at once and one is seen `queued`.
  - `cancel via signal`: aborting mid-download rejects with `CancelledError`, the state is `cancelled`, and no `.part` remains.
- [ ] **Step 2:** Run `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement `DownloadManager`, using `fetch` with an `AbortController` per attempt. A stall timer resets on each chunk.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(downloads): central download manager with retry, resume, verify, dedupe`.

### Task 3: Tasks, history, events, util delegation

**Files:**
- Modify: `server/src/downloads.ts`, `server/src/util.ts:163-215`, `server/src/events.ts`, `server/src/index.ts` (startup sweep)
- Test: `server/src/downloads.test.ts`

**Interfaces:**
- Produces:
```ts
export interface DownloadTask { id: string; label: string; serverId?: string; kind: OwnerKind;
  state: 'active' | 'done' | 'failed' | 'cancelled'; error?: string; startedAt: string; finishedAt?: string;
  canRetry: boolean; jobIds: string[]; }
// on DownloadManager:
startTask(t: { label: string; serverId?: string; kind: OwnerKind; retry?: () => Promise<void> }): { id: string; signal: AbortSignal; ctx: DownloadCtx; done(): void; fail(e: Error): void };
trackProcess(taskId: string, label: string): { signal: AbortSignal; end(ok: boolean, error?: string): void }; // indeterminate job
cancelTask(id: string): void; cancelJob(id: string): void; retryTask(id: string): Promise<void>;
snapshot(): { tasks: DownloadTask[]; jobs: DownloadJob[] }; clearHistory(): void;
export async function sweepPartials(dir: string): Promise<number>;
```
- `BusEvent` gains `{ type: 'download.changed'; job?: DownloadJob; task?: DownloadTask }`.
- `util.ts`: `downloadTo(url, dest, onProgress?, ctx?: DownloadCtx)` delegates to `downloads.download`. `downloadCached(url, onProgress?, ext?, ctx?)` keeps its cache-key naming. When `ctx.sha1`/`ctx.sha512` is given and the cached file exists, it verifies the file and re-downloads on mismatch. Without a hash it reuses the cached file as-is.
- `cancelJob` cancels the job's whole task. History is trimmed to 100 finished items.

- [ ] **Step 1:** Write tests:
  - `cancelTask aborts all jobs in task`: two `/slow` jobs with the task ctx both reject with `CancelledError`, and the task state is `cancelled`.
  - `trackProcess signal aborts on cancel`: `signal.aborted === true` after `cancelTask`.
  - `retryTask calls retry callback`: the callback is called once. A task without one has `canRetry === false`.
  - `history keeps last 100`: after 105 finished jobs, `snapshot().jobs.filter(finished).length === 100`.
  - `publishes download.changed on bus`: at least one `download.changed` event per state change.
  - `reuses legacy cache file without hash` (Review Focus 1): a pre-existing cache file plus `downloadCached` without a hash gives `hits === 0`. With a wrong hash it downloads again.
  - `sweepPartials removes stale .part files` (Review Focus 4): it returns the count, and only `.part` files are removed.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire `downloads.on('change')` → `bus.publish`, throttled. Call `sweepPartials(config.cacheDir)` at startup in `index.ts`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(downloads): tasks, cancel/retry, history, bus events; util delegates`.

### Task 4: API and call-site wiring

**Files:**
- Create: `server/src/routes/downloads.ts` (registered in `index.ts` next to the other route modules)
- Modify: `server/src/install/java.ts`, `server/src/install/bedrock.ts`, `server/src/versions/runtime.ts` (`ensureJava(major, onProgress, ctx?)`), `server/src/addons.ts`, `server/src/modupdates.ts`, `server/src/playit.ts`, `server/src/broadcaster.ts`, `server/src/servers/manager.ts`, `server/src/util.ts` (`run` already passes `SpawnOptions.signal`; keep it)

**Interfaces:**
- Routes (auth required): `GET /api/downloads` → `snapshot()`; `POST /api/downloads/tasks/:id/cancel`; `POST /api/downloads/:id/cancel`; `POST /api/downloads/tasks/:id/retry`; `DELETE /api/downloads/history`.
- `installJava(rec, root, onProgress, initialProps?, ctx?: DownloadCtx)` and `installBedrock(..., ctx?)` pass `ctx` to every download. `runInstaller` takes `ctx` and wraps the child process in `downloads.trackProcess(ctx.taskId, '<Forge|NeoForge> installer: downloading libraries')`, passing `signal` to `run`.
- `manager.installAndMaybeStart` and `changeVersion` call `downloads.startTask({ label: 'Install <TypeLabel> <version> · <name>', serverId, kind: 'server-install', retry: () => this.reinstall(id) })`. On `CancelledError` they set state `error`, detail `Install cancelled`, and log `[Blockhost] Install cancelled`.
- Task labels at the other sites: `Install <mod title> · <server>` (addon), `Update mods · <server>` (mod-update), `Client mod pack · <server>`, `Java <major> runtime` (runtime), `playit agent` and `Xbox broadcaster` (system). Each gets a `retry` that re-runs the same operation.

- [ ] **Step 1:** Implement the routes and wiring.
- [ ] **Step 2:** Run `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 3:** Manual check (`npm run dev`):
  - Create a Fabric server, and `GET /api/downloads` shows a task with jobs.
  - Create a Forge server, cancel during "downloading libraries", and the server shows "Install cancelled" with no installer process left (`ps aux | grep installer`).
  - Retry runs the reinstall.
  - Kill the app mid-install and restart it: no `.part` files in the cache, and the server isn't stuck in `installing` (Review Focus 4).
- [ ] **Step 4:** Commit `feat(downloads): API routes and route all downloads through the manager`.

### Task 5: Downloads UI

**Files:**
- Create: `web/src/components/DownloadsPanel.tsx`, `web/src/hooks/useDownloads.ts`
- Modify: `web/src/components/layout/Shell.tsx`, `web/src/lib/types.ts` (`DownloadJob`, `DownloadTask`, and `WsEvent` gains `download.changed`), `web/src/lib/api.ts`

**Interfaces:**
- `useDownloads(): { tasks; jobs; active: number; cancelTask(id); retryTask(id); clearHistory() }` loads `GET /api/downloads` once, then applies `download.changed` events.
- The panel matches the spec mockup. Sections are **Active** and **Recent**. A task with more than 5 jobs collapses to `<n> files · <done> / <n> · <bytes> / <total>` and expands on click. Speed and ETA show for active jobs. "Retry" appears only when `canRetry`. On screens under `sm` it opens as a full-screen sheet.
- Shell: a lucide `Download` icon in the top bar with a badge showing `active` (hidden at 0), pulsing while `active > 0`.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `cd web && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 3:** Manual check: create a server and watch the badge count go up, the panel show progress, and Cancel and Retry work. Check the layout at a 390 px viewport.
- [ ] **Step 4:** Commit `feat(web): downloads indicator and panel`.

## Part B — Quilt and pinned loaders

### Task 6: Pinned loader versions

**Files:**
- Modify: `server/src/versions/java.ts`, `server/src/install/java.ts`, `server/src/servers/types.ts`
- Test: `server/src/versions/java.test.ts`

**Interfaces:**
- Pure selectors, exported:
  - `pickFabricLoader(list: { loader: { version: string; stable: boolean } }[], pinned?: string): string`. Throws `No Fabric loader <pinned> for this Minecraft version` if `pinned` isn't in the list.
  - `pickForgeVersion(versions: string[], mc: string, pinned?: string): string` and `pickNeoForgeVersion(versions: string[], mc: string, pinned?: string): string`, using the same "pinned must exist" rule.
- `fabricServerJarUrl(version, pinned?)`, `forgeInstallerUrl(mc, pinned?)` and `neoforgeInstallerUrl(mc, pinned?)` use the selectors.
- `ServerRecord.build.pinnedLoaderVersion?: string`. `installJava` passes it, and the result's `build` keeps it.

- [ ] **Step 1:** Write tests:
  - `pickFabricLoader returns newest stable when unpinned`.
  - `pickFabricLoader returns pinned`.
  - `pickFabricLoader throws for unknown pinned`.
  - The same three for Forge and NeoForge. Use realistic version strings, e.g. Forge `1.20.1-47.3.0`, NeoForge `21.1.77`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement by extracting the selection logic from the existing resolvers.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(install): allow pinning loader versions`.

### Task 7: Quilt server type

**Files:**
- Modify: `server/src/servers/types.ts` (`JavaType` adds `'QUILT'`, `JAVA_TYPES`, `MOD_TYPES`), `server/src/versions/java.ts` (`quiltLoaderVersions`, `quiltInstallerUrl`, `listJavaVersions('QUILT')` uses Fabric's game list from Quilt meta `/v3/versions/game`), `server/src/install/java.ts` (case `QUILT`; `cleanOldBinaries` adds `quilt-server-launch.jar` and `.quilt`), `server/src/modupdates.ts` (`LOADERS.QUILT`, client-pack installer link), `server/src/updates.ts`, `server/src/install/java.ts` `installGeyser` (Quilt uses the `fabric` platform plus Fabric API), `server/src/servers/manager.ts` (Geyser allow-list), `web/src/lib/types.ts` (`TYPE_LABEL`, `TYPE_BLURB`), `web/src/pages/NewServer.tsx` (`GEYSER_OK`), and every other `'FABRIC'` check (`grep -rn "'FABRIC'" server/src web/src`; add Quilt wherever the branch is about "Fabric-style mod loader")
- Test: `server/src/versions/java.test.ts`

**Interfaces:**
- `quiltInstallArgs(mc: string, loader: string): string[]` returns `['-jar', 'quilt-installer.jar', 'install', 'server', mc, loader, '--download-server', '--install-dir=.']`.
- `pickQuiltLoader(list: { loader: { version: string } }[], pinned?: string): string` picks the newest version without `-beta`/`-pre` when unpinned.
- The install's launch spec is `{ kind: 'jar', jar: 'quilt-server-launch.jar' }`. The installer run goes through `trackProcess` like Forge.

- [ ] **Step 1:** Write tests: `quiltInstallArgs builds server install command`; `pickQuiltLoader skips beta when unpinned`; `pickQuiltLoader returns pinned`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck && (cd ../web && npm run typecheck)`. Expected: PASS.
- [ ] **Step 5:** Manual check: create a Quilt 1.21.1 server with Geyser. It starts, the log shows Quilt Loader, and Geyser loads.
- [ ] **Step 6:** Commit `feat: add Quilt server type`.

## Part C — Modpacks

### Task 8: mrpack parsing and classification (pure)

**Files:**
- Create: `server/src/modpacks/mrpack.ts`
- Test: `server/src/modpacks/mrpack.test.ts` (build zips in-test with `AdmZip`)

**Interfaces:**
```ts
export interface MrpackFile { path: string; hashes: { sha1: string; sha512: string }; env?: { client?: string; server?: string }; downloads: string[]; fileSize: number; }
export interface MrpackIndex { formatVersion: 1; game: 'minecraft'; name: string; versionId: string; summary?: string; files: MrpackFile[]; dependencies: Record<string, string>; }
export interface PackLoader { type: 'VANILLA' | 'FABRIC' | 'QUILT' | 'FORGE' | 'NEOFORGE'; mc: string; loaderVersion?: string; }
export function readMrpack(file: string): { index: MrpackIndex; overrides: { path: string; source: 'overrides' | 'server-overrides' }[] }; // server-overrides wins on same path; client-overrides ignored
export function loaderFromDeps(deps: Record<string, string>): PackLoader;
export function assertSafeRelPath(p: string): string; // normalised; throws on absolute, '..', backslash-escapes, drive letters
export function classifyOverride(p: string): 'file' | 'config'; // file: under mods/ plugins/ resourcepacks/ datapacks/ or ends .jar/.zip
```
- Error messages: `This looks like a CurseForge pack; only Modrinth (.mrpack) packs are supported` (zip has `manifest.json` but no index), `Not a Modrinth modpack (modrinth.index.json missing)`, `Unsupported modpack format version <n>`.

- [ ] **Step 1:** Write tests:
  - `loaderFromDeps` maps `fabric-loader`, `quilt-loader`, `forge` and `neoforge`, and maps "minecraft only" to VANILLA.
  - `readMrpack lets server-overrides win`.
  - `readMrpack ignores client-overrides`.
  - `assertSafeRelPath rejects ../x, /etc/x, C:\\x, mods/../../x`.
  - `classifyOverride: mods/a.jar→file, config/a.toml→config, resourcepacks/x.zip→file`.
  - `accepts mrpack by content not extension` (Review Focus 3): a file named `pack.zip` parses.
  - `rejects curseforge zip with message` (Review Focus 3).
  - `rejects formatVersion 2`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): parse and classify .mrpack`.

### Task 9: Client-only detection (pure + jar inspection)

**Files:**
- Create: `server/src/modpacks/clientOnly.ts`
- Test: `server/src/modpacks/clientOnly.test.ts`

**Interfaces:**
```ts
export type SkipReason = 'pack-env' | 'modrinth-server-unsupported' | 'mod-metadata-client' | 'admin';
export function jarIsClientOnly(jar: Buffer): boolean; // fabric.mod.json/quilt.mod.json environment === 'client' (quilt: quilt_loader.minecraft.environment), or META-INF/mods.toml / neoforge.mods.toml clientSideOnly=true
export interface SkipDecision { path: string; skip: boolean; reason?: SkipReason; }
export function decideSkips(files: { path: string; env?: { server?: string }; projectServerSide?: string; clientOnlyJar?: boolean }[], adminOverrides: Record<string, boolean>): SkipDecision[];
```
- Precedence: `adminOverrides[path]` (true = skip, false = install) wins. Then `env.server === 'unsupported'`, then `projectServerSide === 'unsupported'`, then `clientOnlyJar`.

- [ ] **Step 1:** Write tests:
  - `jarIsClientOnly` is true for a Fabric `environment: "client"`, false for `"*"`, true for mods.toml `clientSideOnly=true`, and true for Quilt client.
  - `decideSkips` applies the precedence, including `admin override forces install of flagged mod` and `admin override skips required mod`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement (parse TOML with a regex `^\s*clientSideOnly\s*=\s*true` and no new dependency).
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): detect client-only mods`.

### Task 10: Staged packs, Modrinth sources, preview, routes

**Files:**
- Create: `server/src/modpacks/modrinth.ts`, `server/src/modpacks/store.ts`, `server/src/routes/modpacks.ts`
- Test: `server/src/modpacks/modrinth.test.ts`

**Interfaces:**
```ts
// modrinth.ts (fetch injected for tests: `type Fetcher = typeof fetchJson`)
export function searchPacks(q: string, offset: number, f?: Fetcher): Promise<{ hits: { projectId: string; slug: string; title: string; icon?: string; downloads: number; mcVersions: string[]; loaders: string[] }[]; total: number }>;
export function packVersions(idOrSlug: string, f?: Fetcher): Promise<{ id: string; name: string; versionNumber: string; type: string; mc: string[]; loaders: string[]; date: string; fileUrl: string; fileSha1: string }[]>;
export function defaultVersion(vs: { type: string; date: string }[]): number; // index of newest release, else newest
export function identifyPack(mrpackSha1: string, index: { name: string; versionId: string }, f?: Fetcher): Promise<{ projectId: string; slug: string; title: string; icon?: string; versionId: string; versionNumber: string; confidence: 'exact' | 'name-version' } | null>;
export function projectSides(hashes: string[], f?: Fetcher): Promise<Record<string, { projectId: string; serverSide: string }>>; // POST /version_files (sha1) then /projects
// store.ts — <data>/modpacks/<id>/{pack.mrpack, meta.json}
export interface StagedPack { id: string; fileName: string; createdAt: string; index: Pick<MrpackIndex, 'name' | 'versionId' | 'summary'>; loader: PackLoader;
  link: Awaited<ReturnType<typeof identifyPack>>; files: { path: string; size: number; skip: boolean; reason?: SkipReason }[]; overrideCount: number; downloadBytes: number; }
export function stageUpload(req: FastifyRequest): Promise<StagedPack>;
export function stageFromModrinth(versionId: string): Promise<StagedPack>; // downloads via the download manager, kind 'modpack'
export function getStaged(id: string): Promise<StagedPack>; export function listStaged(): Promise<StagedPack[]>; export function deleteStaged(id: string): Promise<void>;
export function stagedFile(id: string): string;
```
- Routes: `POST /api/modpacks/upload`, `POST /api/modpacks/stage { versionId }`, `GET /api/modpacks/staged`, `GET /api/modpacks/staged/:id`, `DELETE /api/modpacks/staged/:id`, `GET /api/modpacks/search?q=&offset=`, `GET /api/modpacks/project/:idOrSlug/versions`.
- The preview's `skip` comes from `decideSkips` with pack env and `projectSides`. Jar inspection runs at install time (Task 11), not at preview.
- The upload route stores the file to disk as it streams (not `toBuffer`), because packs can be large.

- [ ] **Step 1:** Write tests with a stub fetcher:
  - `searchPacks sends modpack + server_side facets and index=downloads when q empty`.
  - `defaultVersion prefers newest release over newer beta`.
  - `identifyPack exact by file hash`.
  - `identifyPack falls back to name + versionId`.
  - `identifyPack returns null when no version_number matches`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): staging, Modrinth search/versions/identify, routes`.

### Task 11: Pack install and create flow

**Files:**
- Create: `server/src/modpacks/install.ts`
- Modify: `server/src/servers/types.ts` (`CreateServerInput.modpack?: { packId: string; skipOverrides?: Record<string, boolean>; link?: boolean }`, `ServerRecord.modpack?: ModpackRecord`), `server/src/servers/manager.ts` (`create`, `installAndMaybeStart`)
- Test: `server/src/modpacks/install.test.ts` (uses the HTTP fixture)

**Interfaces:**
```ts
export interface ManifestFile { path: string; sha1: string; projectId?: string; adminOwned?: boolean; }
export interface ManifestOverride { path: string; packSha1: string; baselineSha1?: string; adminOwned?: boolean; }
export interface ModpackRecord { source: 'modrinth' | 'upload'; projectId?: string; slug?: string; title: string; icon?: string;
  versionId?: string; versionNumber: string; files: ManifestFile[]; overrides: ManifestOverride[];
  skips: Record<string, boolean>; updates: { mode: 'notify' | 'ignore'; skippedVersionId?: string }; }
export function installPackFiles(root: string, mrpack: string, skips: Record<string, boolean>, ctx: DownloadCtx, onProgress: Progress): Promise<Pick<ModpackRecord, 'files' | 'overrides'>>;
```
- Downloads run through `downloads.download` with `sha512`/`sha1` and `expectedSize`, and try each `downloads[]` URL in turn. After download, each jar is checked with `jarIsClientOnly`. A newly flagged jar is deleted unless `skips[path] === false`, and the result is logged as `[Blockhost] Skipped client-only mod <path>`. Override-class `file` entries are recorded in `files`, and `config` entries in `overrides`.
- `manager.create` with `modpack`: loads the staged pack; sets `type`, `version` and `build.pinnedLoaderVersion` from `loader`; uses the pack name when no name is given; fills `rec.modpack` (link fields only when `link !== false && staged.link`; `source` is `'modrinth'` when linked); copies the `.mrpack` to `<server>/.modpack/pack.mrpack` (used by Task 14's download route), then deletes the staged pack after a successful install. `changeVersion` gains an `internal?: boolean` option (used by Task 14). In `installAndMaybeStart` the order is loader install → `installPackFiles` → world import. The whole flow is one download task labelled `Install modpack <title> <version> · <name>`.

- [ ] **Step 1:** Write tests (a pack built in-test whose `downloads` point at the fixture):
  - `installs server files and skips env.server unsupported`.
  - `applies overrides then server-overrides`.
  - `falls back to second download URL` (Review Focus 2): the first URL is `/status/404`.
  - `fails on hash mismatch and leaves no partial file`.
  - `records manifest with files vs config overrides`.
  - `honours admin skip=false for flagged mod`.
  - `rejects unsafe paths before writing anything`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): install packs into new servers`.

### Task 12: Baselines and admin ownership

**Files:**
- Create: `server/src/modpacks/ownership.ts`
- Modify: `server/src/servers/instance.ts` (on the first transition to `running` after a pack install/update, call `snapshotBaselines`), `server/src/files.ts` (`writeFile`, `writeFileBuffer`, `remove` and `rename` call `markAdminOwned(inst, rel)`), `server/src/modupdates.ts` `applyUpdates` (a pack file updated by hand → `adminOwned: true`, new path and hash), `server/src/addons.ts` `deleteAddon` (removing a pack mod → `adminOwned: true` and the file absent, so updates don't re-add it)
- Test: `server/src/modpacks/ownership.test.ts`

**Interfaces:**
```ts
export function isAdminEdited(o: ManifestOverride, currentSha1: string | null): boolean; // adminOwned || (current != null && current !== packSha1 && current !== baselineSha1)
export function snapshotBaselines(inst: ServerInstance): Promise<void>; // fills baselineSha1 where missing; sets rec.modpack.baselinePending = false
export function markAdminOwned(inst: ServerInstance, rel: string): Promise<void>; // no-op for non-pack paths
```
- `ModpackRecord` gains `baselinePending?: boolean`. It is set true after install or update.

- [ ] **Step 1:** Write tests:
  - `isAdminEdited false when matches pack or baseline`.
  - `isAdminEdited true when differs from both`.
  - `isAdminEdited true when adminOwned`.
  - `isAdminEdited false when file missing`.
  - `markAdminOwned ignores non-pack paths`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): track baselines and admin-owned files`.

### Task 13: Update planner (pure)

**Files:**
- Create: `server/src/modpacks/plan.ts`
- Test: `server/src/modpacks/plan.test.ts`

**Interfaces:**
```ts
export type PlanAction =
  | { kind: 'add' | 'replace'; path: string; file: MrpackFile | { override: string } }
  | { kind: 'remove'; path: string }
  | { kind: 'keep-admin-file'; path: string; packPath?: string }   // admin-owned mod; pack copy not installed
  | { kind: 'keep-changed-file'; path: string }                     // pack dropped it but disk hash ≠ recorded
  | { kind: 'write-config'; path: string } | { kind: 'keep-config'; path: string };
export interface UpdatePlan { actions: PlanAction[]; summary: { added: number; updated: number; removed: number; configsUpdated: number; configsKept: string[]; adminKept: string[] }; }
export function planPackUpdate(old: ModpackRecord, next: { files: (MrpackFile & { projectId?: string; skip: boolean })[]; overrides: { path: string; sha1: string; cls: 'file' | 'config' }[] }, disk: Record<string, string | null>): UpdatePlan;
```
- Rules (spec "Design → Pack updates" as amended by "Decisions from review" 1–3):
  - A non-admin-owned old file missing from `next` → `remove` if the disk hash equals the recorded `sha1`, else `keep-changed-file`.
  - A next file whose `projectId` matches an admin-owned old entry → `keep-admin-file`, and the pack copy isn't installed.
  - A next file whose path or projectId matches an old one with a different hash → `replace`.
  - New → `add`. Skipped → nothing.
  - Config override: `write-config` unless `isAdminEdited`, in which case `keep-config`. Config overrides the pack removed stay in place (no action).

- [ ] **Step 1:** Write one test per rule:
  - `removes dropped unchanged mod`.
  - `keeps dropped mod admin replaced`.
  - `does not install pack copy of admin-updated project` (old path `sodium-0.5.jar` adminOwned with projectId P; next has `sodium-0.6.jar` projectId P → one `keep-admin-file`, no `add`).
  - `replaces changed mod by projectId when filename changes`.
  - `jar under overrides/mods follows file rules`.
  - `writes untouched config`.
  - `keeps edited config`.
  - `config rewritten by mod after first start counts as untouched` (disk equals baseline).
  - `leaves configs the pack removed`.
  - `summary counts match actions`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): pure update planner`.

### Task 14: Update check, execute, rollback, skip/ignore, detach

**Files:**
- Create: `server/src/modpacks/update.ts`
- Modify: `server/src/updates.ts` (`UpdateCheck.modpack?`; on modpack servers set `version = { available: false, latest: null, label: 'Managed by the modpack' }` and skip build updates), `server/src/servers/manager.ts` (`changeVersion` throws `bad('This server follows its modpack; detach it first to change the Minecraft version')` when `rec.modpack` and the call isn't from the pack updater), `server/src/routes/content.ts`
- Test: `server/src/modpacks/update.test.ts`

**Interfaces:**
```ts
export function checkPackUpdate(inst: ServerInstance, f?: Fetcher): Promise<{ available: boolean; latest?: { versionId: string; versionNumber: string; mc: string; loader: string; loaderVersion?: string }; changesMcVersion: boolean } | null>; // null when unlinked or mode 'ignore'; hides skippedVersionId
export function applyPackUpdate(inst: ServerInstance, versionId: string): Promise<UpdatePlan['summary'] & { mcChanged: boolean }>;
export function setPackUpdateMode(inst: ServerInstance, mode: 'notify' | 'ignore'): Promise<void>;
export function skipPackVersion(inst: ServerInstance, versionId: string): Promise<void>;
export function detachPack(inst: ServerInstance): Promise<void>; // clears rec.modpack and build.pinnedLoaderVersion
```
- `applyPackUpdate` order:
  1. Stage the new `.mrpack` and download every `add`/`replace` file to `<server>/.pack-staging/` (a download task labelled `Update modpack <title> <old>→<new> · <name>`). No server files are touched yet.
  2. Remember `wasRunning`, then stop.
  3. Take a full backup with the label from Global Constraints.
  4. If MC version, loader or loader version changed: reinstall via `changeVersion(..., { internal: true, backupFirst: false })` with the new pin.
  5. Apply the plan.
  6. Save the record (set `baselinePending: true`).
  7. Remove the staging dir.
  8. Start if `wasRunning`.
  - On any error after step 2: `restoreBackup`, restore the record JSON snapshot taken before step 2, start if `wasRunning`, and rethrow with the message prefixed `Update failed and was rolled back: `.
- Routes: `GET /api/servers/:id/modpack/update`, `POST /api/servers/:id/modpack/update { versionId }`, `POST /api/servers/:id/modpack/skip { versionId }`, `POST /api/servers/:id/modpack/mode { mode }`, `POST /api/servers/:id/modpack/detach`, `GET /api/servers/:id/modpack/file` (downloads the original `.mrpack`, kept at `<server>/.modpack/pack.mrpack` from install).

- [ ] **Step 1:** Write tests (a fake `ServerInstance` with stubbed `stop`/`start`, a fixture HTTP server, and a temp root):
  - `checkPackUpdate returns null when ignored`.
  - `checkPackUpdate hides skipped version`.
  - `checkPackUpdate flags changesMcVersion`.
  - `applyPackUpdate downloads before stopping` (`stop` is called after all fixture hits).
  - `rolls back on apply failure` (inject a failing write → backup restored, record unchanged, error prefix).
  - `restarts server after update and after rollback` (Review Focus 5).
  - `changeVersion refuses on modpack server`.
  - `detachPack clears pin and modpack`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(modpacks): update check, staged apply with rollback, skip/ignore/detach`.

### Task 15: Web UI for modpacks

**Files:**
- Create: `web/src/pages/newserver/ModpackStep.tsx`, `web/src/components/JoinCard.tsx`
- Modify: `web/src/pages/NewServer.tsx`, `web/src/components/UpdatesCard.tsx`, `web/src/pages/server/Overview.tsx`, `web/src/pages/server/Settings.tsx`, `web/src/pages/server/Addons.tsx`, `web/src/lib/api.ts`, `web/src/lib/types.ts`

**Interfaces / behaviour:**
- **NewServer:** step 0 gains a **Modpack** card (and the Quilt card from `JAVA_TYPES`). With Modpack chosen, step 1 is `ModpackStep`. It has an upload button (`<input type="file" accept=".mrpack,application/zip,application/octet-stream">`) with upload progress, a search box (debounced 300 ms), and the popular list when the query is empty, showing icon, title, MC versions, loaders and downloads. Picking a project shows its versions, with the default from `defaultVersion` pre-selected, then `POST /api/modpacks/stage`.
- **Preview:** name, version, MC, loader plus version, `<n> server mods`, `<m> client-only skipped` (expandable list with reason and a checkbox per file to override), download size, and a "Link to Modrinth" checkbox when `link.confidence === 'name-version'` (checked by default), worded "This looks like **<title> v<ver>** on Modrinth — link it?". The memory slider defaults to 4096. Step 2 is unchanged. Create sends `{ modpack: { packId, skipOverrides, link } }`.
- **JoinCard** (Overview, modpack servers only): pack icon, title and version, "Install **<title> v<version>** in the Modrinth App or Prism" with the join link, the connect address (same source as the existing address display, preferring the playit tunnel address), and a "Copy instructions" button that copies plain text. For unlinked packs: "Ask the admin for the pack file", plus an admin "Download pack" button (`GET /api/servers/:id/modpack/file`).
- **UpdatesCard:** a modpack row with **Update**, **Skip this version** and **Ignore updates**. Update confirms with a warning when `changesMcVersion` ("The world will be upgraded to Minecraft <mc>. A full backup is taken first."). Afterwards it shows the summary (added, updated and removed counts, plus the kept configs and admin-kept mods as lists).
- **Settings:** a "Check for modpack updates" toggle and "Detach from modpack" (confirm dialog).
- **Addons (Mods page):** a "From pack" badge on files in `rec.modpack.files`. Updating or deleting one first confirms: "This mod is part of <title>. Updating it may stop players with the pack from joining."

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `cd web && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 3:** Manual end-to-end check:
  - Create a server from the popular list (a Fabric pack): it starts, the join card links to the exact version, and the downloads panel shows the pack task.
  - Upload a Prism export: the link prompt appears.
  - Create from a Quilt pack.
  - Update an older pack version to a newer one: it shows the summary and keeps a config edited in Files.
  - Skip a version, then turn on Ignore: the update row disappears.
  - Detach: the version update shows again.
  - Upload from a phone-sized viewport.
- [ ] **Step 4:** Commit `feat(web): modpack wizard, join card, pack updates UI`.
