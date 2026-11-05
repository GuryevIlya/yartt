# Publishing and releases

How the code gets to GitHub, how every change is checked there, and how a
release becomes an image on Docker Hub that a company runs
([admin/install.md](../admin/install.md)).

## What is already in the repository

| File | What it does |
|---|---|
| `.github/workflows/ci.yml` | every push to `master` or a maintenance branch `v1.2` and every pull request: `npm run typecheck`, `npm test`, `npm run e2e` against PostgreSQL 17 in a service container; the end-to-end report is attached when it fails |
| `.github/workflows/release.yml` | a tag `1.2.3` (no `v`) on a commit of `master` or of `v1.2` whose CI passed there (it waits for a CI still running; nothing is checked twice), then the image for `linux/amd64` and `linux/arm64` pushed to Docker Hub as `1.2.3`, and as `1.2`, `1` and `latest` while it is the newest of them (`0` too: a minor never breaks an installation, in 0.x either), and a GitHub release with notes generated from the commits |
| `.github/dependabot.yml` | weekly minor and patch updates of npm packages and the base image — their major versions are not proposed (they are pinned on purpose); actions come in one pull request with majors too, since those follow GitHub's runtime |

## Once: the repository on GitHub

1. Create the repository on GitHub (empty, without a README or a
   license — they are here already).
2. Push the history and the tags:

   ```sh
   git remote add origin git@github.com:<owner>/yartt.git
   git push -u origin master --tags
   ```

3. **Settings → Branches → Add rule** for `master`: require a pull
   request and the `CI / check` status to pass before merging. From then
   on nothing reaches `master` unchecked.
4. **Settings → Code security**: turn on Dependabot alerts and secret
   scanning (free for public repositories).
5. Before accepting the first outside pull request, install CLA Assistant
   with the agreements in `legal/` — the roadmap item "Contributions with
   a signed assignment" describes it.

## Once: Docker Hub

1. On [hub.docker.com](https://hub.docker.com) create the repository the
   image goes to, e.g. `yartt/yartt` (an organization keeps it apart from
   a personal account), public.
2. **Account settings → Personal access tokens → Generate**, access
   "Read & Write", named "GitHub Actions yartt".
3. In GitHub, **Settings → Secrets and variables → Actions**:
   - secrets `DOCKERHUB_USERNAME` (the Docker Hub account) and
     `DOCKERHUB_TOKEN` (the token from step 2);
   - variable `DOCKERHUB_REPOSITORY` = `yartt/yartt`.

## Branches

`master` holds released versions and fixes to them, nothing half done:
whoever builds yartt from `master` gets the latest release or a patch of
it.

- **A release is prepared on its own branch**, `v<major>.<minor>`, made
  from `master`: `v0.8` for 0.8.0. Features go there. Its version in
  `package.json` is `0.8.0-alpha` while features come in, `0.8.0-beta`
  when they are all in and being checked; the footer shows it, so a
  build from the branch says it is not a release.
- **A fix of the released version goes to `master`** (as the next
  patch, if it is to be released at once), and `master` is merged into
  the release branch, so the release keeps it.
- **At the release** the branch gets the final version, is merged into
  `master`, and the tag is put on `master`. The branch stays as the
  maintenance branch of its line ([below](#a-fix-for-an-older-line)).

## Every release

1. On the release branch, with CI green, decide the version: patch —
   fixes only, never the schema, and made on `master`; minor — features;
   major — only from the last minor (AGENTS.md, Database).
2. If the schema changed since the last release, there is a migration
   `server/migrations/<from>-<to>.sql` and the new version in `db.sql`.
   The first schema version is 0.0. CI checks every migration against
   `db.sql` and the test data as they were at each release tag (git
   history, hence the full checkout in the workflows), so the released
   schema needs no copy. With a migration, rebuild the test data by
   `npm run fixture -- --migrate` and review its diff
   ([testing.md](testing.md)).
3. Set `"version"` in `package.json` (the footer shows it; the release
   workflow refuses a tag that does not match), commit it, then tag and
   push:

   ```sh
   git switch master && git merge v1.0   # a patch is tagged on master as it is
   git tag 1.0.0
   git push origin master 1.0.0
   ```

4. Watch **Actions → Release**. It does not run the checks again: it
   requires the tagged commit to be on `master` with CI passed for it,
   and waits while that CI is still running. Tag the latest commit —
   CI of an earlier one may have been cancelled by the next push, and
   then the release stops. When it is green the image is on Docker
   Hub and the release with its notes is on GitHub. The notes are made by
   `scripts/release-notes.ts` from the history since the previous release:
   the commit subjects, which is why they are written as a changelog, and
   "Before upgrading" — a schema change with what each migration does, the
   settings that came or went, the installation guide that changed. See
   them before tagging: `node scripts/release-notes.ts <previous tag>` shows
   the last ones, and the next ones once the tag is made locally.
5. Check the image as a company would: `docker pull yartt/yartt:1.0.0`
   and start it against an empty PostgreSQL by
   [admin/install.md](../admin/install.md).

## A fix for an older line

When a company stays on an older major version (say 1.x while `master`
is at 2.x) and needs a fix, it comes as a patch from a maintenance
branch named after the last minor of that line, `v1.4`:

```sh
git switch -c v1.4 1.4.2        # once: the branch from the last release of the line
git cherry-pick <the fix>       # or fix it there; then the version in package.json
git push origin v1.4            # CI runs on the branch
git tag 1.4.3 && git push origin 1.4.3
```

The release requires the tag to be on `master` or on `v<major>.<minor>`
of its own line, with CI passed there. It moves `1.4` and `1` to the
patch but never `latest`, and the GitHub release is not marked latest:
both stay with the newest version. A maintenance branch gets patches
only — never a schema change (patches never change the schema), so
its releases stay on the migration chain of `master`.

A broken release is not re-tagged: fix forward with the next patch
version, so nobody runs two different images under one number.

## Worth adding when the project grows

- **`SECURITY.md`** — how to report a vulnerability privately (GitHub's
  private vulnerability reporting can be turned on in the security
  settings).
- **The Docker Hub description** from the README, kept in step by an
  extra step in the release workflow (`peter-evans/dockerhub-description`).
- **GitHub Container Registry** as a second registry: the same
  `docker/login-action` with `ghcr.io` and the workflow's `GITHUB_TOKEN`.
- **Signed images** (cosign, keyless through GitHub's OIDC) and an SBOM —
  `docker/build-push-action` can attach the SBOM and provenance.
- **Issue and pull request templates** in `.github/`, so reports come
  with the version and the steps.
