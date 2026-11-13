# Release preparation

This is a preparation checklist, not authorization to merge, publish, deploy,
change credentials, or alter an installed CLI. Keep the current PRs open and
held with `/doomer no-approve` until the user explicitly authorizes release work.

## Candidate contract

- The manager installs `@doomerlabs/doomer` and the native Go CLI separately.
- The production skill source is the reviewed immutable commit in
  `src/skill-source.js`; it must exist and pass the onboarding rehearsal.
- The package version is currently `0.1.0`. Confirm the version is still unused
  immediately before authorized publication; never overwrite a published version.
- Pack with `npm pack --ignore-scripts` and inspect the actual tarball. Test that
  tarball in a disposable home before publishing. Record its integrity digest.
- Build Go release archives only in CI. Use build/verify modes of the existing
  release script with no publishing credentials. A rehearsal version is not a tag
  and must never be promoted as a customer release.
- Keep the older `doomer-review` skill and its pinned CLI intact. The paused
  watch-root development patch is excluded from this release.

## Before approval

1. Verify the candidate npm tarball installs into a fresh disposable home,
   installs the pinned skill, supports standalone review setup and can add hooks
   afterward without inventing upload approval or native hook trust.
2. Run the shared Linux suite against the candidate release binary and final
   Node/skill sources. Inspect selection evidence, then prove signed R2 reuse
   with a cache-only replay. Report executed tests separately from cache hits.
3. Exercise native macOS installation, first review, standalone mode and hook
   repair with both supported agents. Native results do not populate Linux's
   shared cache. Verify all four Go archives, checksums, manifest and Homebrew
   formula from the same build-only bundle. Require `uname -s` to report Darwin;
   a job label containing macOS is not evidence of a native Mac execution.
4. Confirm the publisher can access the npm package and that the existing Go
   release pipeline has its protected publication credentials. An absent npm
   session is a release-day blocker, not permission to copy or replace credentials.
5. Recheck PR CI and review conversations after the last code change. Do not use
   a passing run on older source as final-source evidence.

## After explicit approval

- Integrate the shared test runner and new skill, then the Go and Node changes.
  Preserve tested dependency pins and rerun checks for the exact main commits.
  Nothing in this checklist authorizes those merges.
- Rehearse the final package/archive combination before pushing a release tag.
  Use a new four-part Go CalVer (`YYYY.M.D.N`) for the actual release date.
- Publish and verify the Go release first: GitHub assets, public downloads,
  stable channel, signed managed catalog, and Homebrew formula. Preserve old
  managed catalog entries and the legacy bootstrap pin.
- Publish the reviewed npm package only after the public Go channel supplies
  the compatible CLI. Verify registry integrity against the reviewed tarball and
  perform a disposable public-install smoke test.
- Deploy the website installation instructions only after the npm command and
  compatible public CLI work. If a site merge triggers deployment, keep it held
  until then. Verify the deployed service supports the candidate review protocol
  before directing customers to the new flow.
- Watch first-install and review failures; have a documented rollback decision.
  Never move a published tag or overwrite release assets to roll back.

No production operations have been authorized by preparing this document.
