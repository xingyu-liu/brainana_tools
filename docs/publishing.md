# Publishing a release

How to turn the source in this repo into downloadable apps that anyone can install on
**macOS (Apple Silicon + Intel), Windows, and Linux** — written for someone doing it for the
first time. No prior release experience assumed.

If you want the *why* behind the packaging (Electron, what ships, signing trade-offs), read
[desktop-app.md](desktop-app.md). This page is the **procedure**.

---

## The idea in one picture

You never hand users the source code or ask them to run `npm`. Instead:

```
   your source (this repo, on GitHub)
              │
              │  you push a version tag, e.g.  v0.1.0
              ▼
   GitHub Actions builds the installers
   ├─ macOS runner  → Brainana Viewer .dmg / .zip  (Apple Silicon AND Intel)
   ├─ Windows runner → Brainana Viewer .exe
   └─ Linux runner   → Brainana Viewer .AppImage / .deb
              │
              ▼
   a GitHub *Release* (a download page attached to the tag)
              │
              ▼
   users click the file for their OS and install it
```

Two facts that explain the whole design:

- **A macOS installer can only be built on a Mac, a Windows installer only on Windows, a Linux
  one only on Linux.** electron-builder cannot cross-compile them. That is why we let GitHub run
  three machines for us instead of needing you to own all of them.
- **Built apps are large binaries, so they do NOT live in the git repo.** They live as
  *attachments on a GitHub Release*. `.gitignore` already excludes the build output
  (`apps/*/release/`), so you can never accidentally commit a 100 MB installer.

**Where do the apps go in the repo?** Nowhere — that is the correct answer. Source stays in the
repo; the built apps become **Release assets**. The GitHub repo layout you already have is right.

---

## One-time setup (do this once, ever)

1. **The repo must be on GitHub with an `origin` remote.** Check:

   ```sh
   git remote -v          # should list a github.com URL named "origin"
   ```

   If it prints nothing, create an empty repo on github.com, then:

   ```sh
   git remote add origin https://github.com/<you>/<repo>.git   # point this repo at GitHub
   git push -u origin main                                     # upload the source
   ```

   The Release **destination** is pinned in
   [../apps/viewer/electron-builder.yml](../apps/viewer/electron-builder.yml) (`publish.owner` /
   `repo` = `arcaro-lab/brainana_tools`). Push the `v*` tag to **that** repo: the workflow's
   `GITHUB_TOKEN` can only publish to the repo it runs in, so the tag and the `publish.owner` must
   name the same repo. Enable **Settings → Actions** on it (step 2).

2. **Make sure Actions is enabled.** On github.com → your repo → **Settings → Actions → General**
   → allow actions. (It's on by default for most accounts.)

3. **Nothing else.** For the free/unsigned first release there are **no secrets, tokens, or paid
   accounts to set up.** GitHub automatically gives the workflow a `GITHUB_TOKEN` with permission
   to create the Release (this is wired in `.github/workflows/release.yml`).

---

## Cutting a release (the routine you repeat each version)

### 1. Finalize the changelog

Open [../CHANGELOG.md](../CHANGELOG.md). Change the top heading from the "unreleased" placeholder
to the version and today's date, e.g.:

```diff
- ## [0.1.0] — unreleased
+ ## [0.1.0] — 2026-07-17
```

Make sure the bullet list under it reflects what's actually in this release.

### 2. Set the version number

Run one command — it is the single source of the release version:

```sh
npm run set-version 1.0.0        # bump every package.json + regenerate version.mjs + refresh the lockfile
```

`scripts/set-version.mjs` writes the version into the root and every workspace `package.json`
(so none drift), regenerates `packages/core-server/version.mjs` (which `generate-version.mjs`
bakes into the app alongside the git tag/commit, so the About/version string matches the tag),
and refreshes `package-lock.json` — the last step matters because CI runs `npm ci`, which
**fails** if the lockfile and `package.json` versions disagree. Use
[semver](https://semver.org): `MAJOR.MINOR.PATCH` — bump PATCH for fixes (`1.0.1`), MINOR for
features (`1.1.0`), MAJOR for breaking changes (`2.0.0`).

### 3. Commit the version + changelog

```sh
git add -A                                       # stage changelog + all bumped manifests + lockfile
git commit -m "Release 1.0.0"                    # record it on main
git push origin main                             # upload the commit
```

### 4. Tag the release and push the tag

The **tag is the trigger** — pushing it is what starts the build.

```sh
git tag v0.1.0                                   # mark this commit as version 0.1.0
git push origin v0.1.0                           # pushing the tag launches the release workflow
```

> The tag must start with `v` (e.g. `v0.1.0`) — that's the pattern the workflow listens for.
> Keep the tag's number equal to `package.json`'s `version`.

### 5. Watch the build

On github.com → your repo → **Actions** tab → the **Release** run. Three jobs run in parallel
(ubuntu / windows / macos). They take roughly 5–15 minutes. Each one builds its installers and
uploads them to the **published** Release for the `v0.1.0` tag.

> **`publish.releaseType: release`** (set in `electron-builder.yml`) means the installers attach
> to a **published, public** Release — there is no draft-review gate. If no Release exists for the
> tag yet, the workflow **creates one, already public**; if you pre-created/published a Release for
> the tag (see the alternative trigger below), the installers attach to that one.

### 6. Confirm the Release assets

Go to the **Releases** page (repo home → "Releases" on the right). Open the `v0.1.0` Release and
confirm these assets are attached:

| OS | Files a user downloads |
|---|---|
| macOS, Apple Silicon (M1/M2/M3…) | `Brainana Viewer-0.1.0-arm64.dmg` |
| macOS, Intel | `Brainana Viewer-0.1.0.dmg` (x64) |
| Windows | `Brainana Viewer Setup 0.1.0.exe` |
| Linux | `Brainana Viewer-0.1.0.AppImage`, `brainana-viewer_0.1.0_amd64.deb` |

(`.zip` copies of the Mac apps and `.yml`/`.blockmap` metadata files also appear — those are for
future auto-update; leave them attached.)

Click **Edit** to add or refine the "what's new" notes (paste from the changelog) whenever you like
— the Release is already public and downloadable.

> **Two ways to trigger the same build** (both wired in `.github/workflows/release.yml`):
> 1. **Push the `v*` tag** (steps 4–5 above) → the workflow creates the public Release with the installers.
> 2. **Publish a Release from the GitHub UI** (Releases → *Draft a new release* → create the `v0.1.0`
>    tag → write notes → **Publish**) → the `release: published` trigger runs the same build, and the
>    installers attach to the Release you just published.
>
> ⚠️ Do **not** mix them by publishing a Release in the UI *and* expecting a tag push to also fire —
> a tag/Release created in the UI does **not** emit a tag-`push` event (that's what the
> `release: published` trigger is for).

### 7. Verify

Download at least one installer and confirm it launches. Ideally test one per OS if you have
access. See "What your users will see" below for the expected first-launch prompts.

---

## What your users will see (unsigned build)

This first release is **unsigned** — free, but each OS shows a one-time "unknown developer"
prompt because we haven't paid for a signing certificate. Tell your users:

- **macOS** — double-clicking may say the app "cannot be opened because it is from an
  unidentified developer" or "is damaged". Fix: **right-click the app → Open → Open** (only needed
  the first time). If macOS still refuses, run once in Terminal:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Brainana Viewer.app"   # clear the download quarantine flag
  ```

  Users must pick the download matching their chip: **Apple Silicon → the `-arm64.dmg`**,
  **Intel → the plain `.dmg`**. (About This Mac shows which chip they have.)
- **Windows** — SmartScreen may show a blue "Windows protected your PC" box. Fix: **More info →
  Run anyway** (first time only).
- **Linux** — no warning. For the AppImage: `chmod +x 'Brainana Viewer-0.1.0.AppImage'` then run
  it. For the `.deb`: `sudo apt install ./brainana-viewer_0.1.0_amd64.deb`.

Removing these prompts requires paid signing — see **Later: signed & notarized** below.

---

## Manual fallback (building one OS locally)

You normally never need this — the workflow builds everything. But to produce an installer on the
machine you're sitting at (e.g. to test packaging before tagging):

```sh
npm run dist:desktop        # builds installers for THIS OS only → apps/viewer/release/
```

This builds only the current OS, and on a Mac only the current chip. It does **not** publish
anything (no tag, no upload). Use it for local testing; use the tag + workflow for real releases.

---

## Troubleshooting

- **One OS job failed, the others passed.** Open the failed job in the Actions tab, read the log,
  fix, and re-run *just that job* ("Re-run failed jobs"). The Release keeps the assets the
  successful jobs already uploaded.
- **The workflow didn't start at all.** Either **push a `v*` tag** with `git push origin v0.1.0`
  (pushing the commit alone doesn't push tags), **or** publish a Release from the GitHub UI (the
  `release: published` trigger). A tag/Release created in the UI does **not** emit a tag-`push`
  event, so `push: tags` alone would skip it. Confirm Actions is enabled (one-time setup #2).
- **Jobs are green but no installers are attached — log says `existing type not compatible with
  publishing type … existingType=release publishingType=draft`.** This is the old `draft` behavior:
  a published Release already exists for the tag but the config wanted a draft. Fixed by
  `publish.releaseType: release` in `electron-builder.yml`. If you hit it on a release built from an
  older commit, either delete that published Release (keep the tag) and re-run the jobs, or rebuild
  from a commit that includes `releaseType: release`.
- **"Resource not accessible by integration" / release upload denied.** The workflow declares
  `permissions: contents: write` in `release.yml`, which **overrides** an org/repo read-only default
  for the `GITHUB_TOKEN` — so the greyed-out "Read repository contents…" default under **Settings →
  Actions → General → Workflow permissions** is fine and does not need changing.
- **I tagged the wrong commit / wrong version.** Delete the tag and the Release, then redo:

  ```sh
  git push --delete origin v0.1.0     # remove the remote tag
  git tag -d v0.1.0                    # remove the local tag
  ```

  Delete the Release on github.com, fix things, and tag again.
- **`.deb` fails to build on the Linux runner.** Rare; usually a missing `fakeroot`/`dpkg`. Add a
  step before packaging on the ubuntu job: `sudo apt-get update && sudo apt-get install -y fakeroot`.
- **Two Mac assets have the same name.** The Intel build is the plain `.dmg`; Apple Silicon is
  `-arm64.dmg`. If they collide, confirm the mac job passed `--arm64 --x64` (it's set in
  `release.yml`).

---

## Later: signed & notarized (optional, paid)

Signing removes the first-launch warnings above. It's not required to ship, and everything here
works without it. When you're ready for wider distribution:

- **macOS** — an Apple Developer account ($99/yr) for notarization.
- **Windows** — a code-signing certificate (~$100–400/yr) to clear SmartScreen.

The exact config changes and the environment secrets to add are documented in
[desktop-app.md](desktop-app.md#distribution--signing) and in the commented "LATER — signing"
block of [../apps/viewer/electron-builder.yml](../apps/viewer/electron-builder.yml). Once
configured, the same tag-push workflow signs automatically.

---

## Related docs

- [desktop-app.md](desktop-app.md) — how the desktop app is built, what ships in it, signing rationale.
- [dev_guideline.md](dev_guideline.md) — running and developing the app locally.
- [../CHANGELOG.md](../CHANGELOG.md) — the version history you update in step 1.
