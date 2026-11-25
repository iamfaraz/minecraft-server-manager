# Modpack servers (.mrpack) — design

Date: 2026-11-25

## Intent

Let the admin stand up a modded Java server from a Modrinth modpack in one pass, so friends can join a modded
server with as little friction as possible. The admin usually downloads packs from modrinth.com (on a phone or a
computer) and sometimes exports them from Prism Launcher or the Modrinth App.

The real success measure is **players getting in**: the server runs exactly the pack version players install, and
the app tells players what to install.

## Goals

1. Create a server from a modpack, three ways, all in the New Server wizard:
   - **Upload** a `.mrpack` file (Modrinth download, Prism export, Modrinth App export).
   - **Search** Modrinth modpacks by name.
   - **Browse** a recommended list (Modrinth's most-downloaded modpacks that support servers).
2. The pack decides Minecraft version, loader and exact loader version. The app installs them, downloads
   server-side files (hash-verified), skips client-only files, and applies the pack's overrides.
3. Add **Quilt** as a supported server type (needed by some packs; also selectable on its own like Fabric).
4. Remember which pack and version a server runs, and show a **"How to join"** card for players linking to that
   exact pack version on Modrinth, plus the connect address.
5. **Pack updates**, surfaced in the existing Updates card, with three choices: **Update**, **Skip this version**,
   **Ignore updates** (toggle, reversible in server settings).

## Non-goals

- CurseForge packs (`.zip` with `manifest.json`) — not in scope.
- Bedrock.
- Building or editing packs inside the app.
- Auto-applying updates on a schedule. Updates are always admin-initiated.

## Anti-goals (would be a failure even if it "works")

- Server crashes on first start because a client-only mod (shaders, minimap, UI) was installed.
- An update silently deletes mods the admin added by hand, or wipes config edits the admin made.
- Server and players drift apart without the app saying so (pack version on server ≠ what the join card says).
- Uploading a pack from a phone is painful (must work from mobile browser file picker).

## Constraints / current state

- Install pipeline: `server/src/install/java.ts` `installJava()` installs Fabric/Forge/NeoForge but always resolves
  the **newest** loader for the MC version (`fabricServerJarUrl`, `forgeInstallerUrl`, `neoforgeInstallerUrl` in
  `server/src/versions/java.ts`). Packs pin an exact loader version → these must accept an optional pinned version.
- Server types are a closed union (`JavaType` in `server/src/servers/types.ts`); `'FABRIC'` is referenced in ~20
  places across server and web. Quilt must be added everywhere Fabric-specific logic applies (mod dir, Geyser
  Fabric-platform build, Modrinth loader lists in `modupdates.ts`, `updates.ts`, client-pack export, UI labels).
- Uploads: Fastify multipart is registered (4 GB file limit). Existing world-import upload in `imports.ts` /
  `routes/misc.ts` is the pattern to follow (stage to temp dir, extract, register).
- Modrinth API client usage already exists in `server/src/modupdates.ts` (`MR` base URL).
- Creation is async: `manager.create()` writes the record, then `installAndMaybeStart()` installs while progress
  streams over the websocket. Pack install slots in after the loader install, before world import.
- Backups: `createBackup(inst, { scope })` exists; version change already takes a pre-update backup.
- Per-mod updates exist on the Mods page (`modupdates.ts` + `pages/server/Addons.tsx`).

## Approaches considered

1. **Native implementation (chosen).** Backend parses `modrinth.index.json`, downloads files with hash checks,
   applies overrides, calls the existing installer with a pinned loader version, adds Quilt as a type, and records a
   pack manifest on the server. Most code, but full control over update semantics, progress reporting and the join
   card — which are the core of the feature.
2. **Shell out to a CLI (e.g. `mrpack-install`).** Fastest first version, but its overwrite rules wouldn't match
   "keep my edits", progress is coarse, and every pack install depends on an external binary. Rejected.
3. **Pack as an add-on installed from the Mods page onto a plain Fabric server.** More steps for the admin; works
   against "with ease". Dropped.

The admin picked **1**.

## Design

### .mrpack handling (backend, new module `server/src/modpacks.ts`)

A `.mrpack` is a zip containing:
- `modrinth.index.json`: `formatVersion` (1), `game: "minecraft"`, `name`, `versionId`, `summary?`,
  `files[]` (`path`, `hashes.sha1`, `hashes.sha512`, `env?.server`/`env?.client`, `downloads[]`, `fileSize`),
  `dependencies` (`minecraft`, and one of `fabric-loader`, `quilt-loader`, `forge`, `neoforge`).
- `overrides/` (both sides) and `server-overrides/` (server only, applied after `overrides/`).
  `client-overrides/` is ignored.

Rules:
- **Loader** from `dependencies`: `fabric-loader`→FABRIC, `quilt-loader`→QUILT, `forge`→FORGE, `neoforge`→NEOFORGE.
  No loader → VANILLA (datapack/resource-only packs). Reject with a clear message if `game` isn't minecraft or
  `formatVersion` isn't 1.
- **File selection**: skip any file whose `env.server === 'unsupported'`. Install `required` and `optional` (and files
  with no `env`). (Optional server files are installed by default — packs mark many real server mods optional.)
- **Path safety**: reject any `path` or override entry that is absolute or escapes the server root (`..`). Zip-slip
  protection on extraction.
- **Download hosts**: only download from the URLs listed in `downloads[]`; verify sha512 (fallback sha1). Fail the
  install on mismatch. Use a bounded concurrency (~6) and the existing `Progress` callback for overall % by bytes.
- Downloads are cached through `downloadCached` keyed by hash, so re-creating / updating reuses files.

### Pack sources

- **Upload**: `POST /api/modpacks/upload` (multipart). Stores the file under `<data>/modpacks/<id>/pack.mrpack`,
  parses the index, returns a preview: name, pack version, MC version, loader + version, file counts (server /
  skipped client-only), total download size. Uploads stay until used or deleted (like world imports); list +
  delete endpoints.
- **Search**: `GET /api/modpacks/search?q=&offset=` → Modrinth `/search` with `facets=[["project_type:modpack"],
  ["server_side:required","server_side:optional"]]`. Empty `q` with `index=downloads` = the **recommended/popular**
  list.
- **Project versions**: `GET /api/modpacks/project/:idOrSlug/versions` → list of pack versions (name, number,
  MC version, loaders, date). Default selection: newest release (not beta/alpha).
- Choosing a Modrinth version: the backend downloads that version's primary `.mrpack` file and treats it exactly like
  an upload (same preview). From then on both paths are identical.

### Creation flow

- `CreateServerInput` gains `modpack?: { packId: string }` (the staged pack's id). When present, `type`, `version`
  and loader version come from the pack; the request's `type`/`version` are ignored/validated against it.
- `ServerRecord.build` gains `pinnedLoaderVersion?`; `installJava()` passes it to the version resolvers, which use it
  instead of "newest stable". Normal reinstall/"build update" on a modpack server keeps the pin (loader updates come
  with pack updates, not the generic build-update path).
- In `installAndMaybeStart()`: install loader → install pack files + overrides → (optional world import) → ready.
- Defaults from the pack: suggested server name = pack name; memory default bumped to 4 GB for modpacks (admin can
  change). Geyser stays available where it is today (and on Quilt via the Fabric build); off by default.

### Pack record (on `ServerRecord`)

```ts
modpack?: {
  source: 'modrinth' | 'upload';
  projectId?: string; slug?: string; title: string; icon?: string;
  versionId?: string;          // Modrinth version id when known
  versionNumber: string;       // e.g. "1.6.1"
  files: { path: string; sha1: string }[];       // mod/files the pack installed
  overrides: { path: string; sha1: string }[];   // override files as written by the pack
  updates: { mode: 'notify' | 'ignore'; skippedVersionId?: string };
}
```

For uploads from Prism/Modrinth App exports, try to identify the pack on Modrinth (hash lookup of the `.mrpack`
via `/version_file/{sha1}`). If found, fill `projectId`/`versionId` so updates and the join link work; if not, it's a
private pack: no update checks, join card shows "Ask the admin for the pack file" and offers a download of the
original `.mrpack` from the server page (authenticated admin download; admin shares it).

### "How to join" card (server page)

Shown on modpack servers. Contents: pack icon/name/version, "Install **<pack> v<version>** in the Modrinth App or
Prism" with a link to `https://modrinth.com/modpack/<slug>/version/<versionNumber>`, and the connect address
(existing address/port logic, including playit tunnel address if one exists). A "Copy instructions" button copies a
plain-text version for pasting into a group chat.

### Pack updates

- Check: extend `updates.ts` check result with `modpack?: { available, latest: { versionId, versionNumber, mc,
  loader, loaderVersion }, changesMcVersion: boolean }`. Uses Modrinth `/project/:id/version`, newest release
  compatible with the pack's loader. Respects `mode: 'ignore'` (no check) and `skippedVersionId` (hide that one).
- UI in the Updates card: **Update**, **Skip this version**, **Ignore updates**. Settings page gets a toggle to turn
  update checks back on.
- **Update** procedure (stops server if running, restarts after if it was running):
  1. Full backup (`scope: 'full'`), labelled `pre-modpack-<old>→<new>`.
  2. If MC version or loader/loader version changed: reinstall via the existing version-change path with the new
     pin; warn in the UI beforehand when the MC version changes ("world will be upgraded").
  3. Files: delete files in the old `files` list that are absent from the new pack (only if their current hash still
     matches what the pack installed — if the admin replaced it, leave it and report). Download/replace the rest.
     Files not in the old list (admin-added mods) are never touched.
  4. Overrides: for each override in the new pack — if the file on disk is missing or its hash equals the old
     recorded override hash (admin never edited it), write the new one. If the admin edited it, keep theirs and list
     it in the result ("kept your version of config/x.toml"). Overrides removed from the pack are left in place.
  5. Save the new manifest; the join card shows the new version.
- Result summary shown to the admin: mods added/updated/removed, configs updated, configs kept.

### Interaction with per-mod updates (Mods page)

Mods that came from the pack get a "From pack" badge. Updating one individually shows a confirm: "This mod is part of
<pack>. Updating it may stop players with the pack from joining." Allowed after confirm. Its manifest entry is
updated to the new hash so a later pack update treats it as "admin-changed" (left alone) — see rule 3.

### Quilt support

- New `JavaType` `'QUILT'`, in `MOD_TYPES`. Install: run the Quilt installer jar
  (`https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/<v>/quilt-installer-<v>.jar`, newest
  from Quilt meta) with `install server <mc> [<loader>] --download-server --install-dir=.`; launch target
  `quilt-server-launch.jar`. Loader versions from `https://meta.quiltmc.org/v3/versions/loader/<mc>`.
- Selectable as a normal flavor in the wizard, too (like Fabric).
- Modrinth loader list for Quilt: `['quilt', 'fabric']` (Quilt runs most Fabric mods).
- Geyser on Quilt: use the Fabric build + Fabric API (Quilt loads them); otherwise treat like Fabric everywhere
  Fabric-specific code exists (`cleanOldBinaries`, update checks, client-pack export installer link, labels).

### Web UI

- `NewServer.tsx` step 0 (Flavor): new **Modpack** card. Choosing it replaces step 1 ("Version & resources") with a
  **Pack** step: upload button + search box + popular list (icon, title, MC version, loader, downloads). Picking a
  project opens its version list; picking a version or uploading shows the preview (name, version, MC, loader,
  N server mods / M client-only skipped, download size). Memory slider remains on this step. Step 3 (World &
  gameplay) unchanged.
- Mobile-friendly file input (`accept=".mrpack"`; also accept `application/zip` / any since some mobile browsers
  don't know the extension).
- Server page: "How to join" card; Updates card gains the modpack row; settings gets the update toggle.
- Mods page: "From pack" badge + confirm.

## Decisions from review (designer's calls, not yet confirmed by the admin)

These refine and, where they conflict, **override** the rules above.

1. **What counts as an admin edit of a config.** Mods rewrite their own configs on first start, so "hash differs
   from what the pack wrote" is not an admin edit. Each override entry stores two hashes: `packSha1` (as written) and
   `baselineSha1`, snapshotted after the first successful start of that pack version (server reached "running").
   A file is *admin-edited* if it was saved through the app's file editor/upload (`files.ts` marks it
   `adminOwned: true` in the manifest) or its current hash matches neither `packSha1` nor `baselineSha1`. On update,
   non-admin-edited configs get the new pack version; admin-edited ones are kept and reported.
2. **Manifest keyed by origin, not just path.** Each `files` entry stores `path`, `sha1`, and Modrinth
   `projectId` when known (looked up by hash at install, batch `/version_files`). A per-mod update from the Mods page
   marks that entry `adminOwned: true` and records its new path/hash. On pack update, an admin-owned mod is **left
   alone and reported** ("you updated Sodium yourself; pack ships 0.6.2"), and the pack's copy of the same project is
   **not** installed, so no duplicates. Rule 3's "replace the rest" applies only to non-admin-owned entries.
3. **Jars and other binaries in `overrides/` follow the mod rules**, not the config rules: any override path under
   `mods/`, `plugins/`, `resourcepacks/`, `datapacks/` or ending `.jar`/`.zip` is a *file* entry — removed on update
   when the pack drops it and it's unchanged, replaced when the pack changes it. Everything else is a *config* entry.
4. **Client-only detection beyond `env.server`.** Skip a file when any of: `env.server === 'unsupported'`; its
   Modrinth project has `server_side: 'unsupported'`; the jar's `fabric.mod.json`/`quilt.mod.json` has
   `environment: "client"`; Forge/NeoForge `mods.toml` declares `clientSideOnly=true` (or `displayTest="IGNORE_ALL_VERSION"`
   with only client entrypoints is **not** used — too unreliable). Skipping is automatic, but the preview lists every
   skipped file with its reason and the admin can untick a skip (or tick an extra file to skip) before creating.
   Choices are stored so updates honour them.
5. **Identifying launcher exports.** Try in order: (a) sha1 of the `.mrpack` via `/version_file`; (b) Modrinth search
   for the index `name` among modpacks, then a version whose `version_number` equals the index `versionId`. If (b)
   finds a match, the preview asks "This looks like **<pack> v<ver>** on Modrinth — link it?" (default yes). No match
   or declined → private pack.
6. **Failed updates.** Stage first: download and verify every new file into a temp dir before touching the server.
   Only then stop the server and apply. If applying (or the loader reinstall) fails, automatically restore the
   pre-update full backup and the previous record, and report the error. The server never stays half-updated.
7. **Generic Minecraft-version updates are hidden on modpack servers** (the Updates card shows only the pack row);
   the version-change endpoint refuses on modpack servers unless the admin first unlinks the pack (Settings →
   "Detach from modpack", which clears `modpack` and the loader pin and turns it into a normal modded server).

## Left to the builder

- Exact component split, endpoint naming beyond what's above, and test structure.
- Concurrency limit and caching keys for downloads.
- Visual details within the existing UI style.
- Whether the staged-pack store shares code with world imports.
