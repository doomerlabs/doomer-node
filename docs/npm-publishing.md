# npm publishing

The installer uses stable SemVer independently of the Go CLI version. Publish
`0.0.2`, `0.0.3`, and so on; do not reuse an npm version or add a Node beta channel.
The initial `0.0.1` package was published manually. The first automated run verifies and tags that existing release; it never
deletes or republishes its immutable npm bytes. Merging the workflow alone
does not publish anything.

## CI responsibilities

- Depot runs `.depot/workflows/ci.yml` on main pushes and pull requests. It tests
  the package, creates its npm tarball, and records the source commit and SHA-512
  integrity in the successful `ci / package` check summary. The tarball and
  evidence are retained as Depot artifacts.
- Depot also runs the existing shared onboarding E2E workflow on main pushes
  and pull requests. Jev selection, dependency projections, signed R2 reuse,
  frozen component pins, and the existing credential isolation are preserved.
- GitHub Actions runs `.github/workflows/publish.yml` only for numeric tag pushes,
  on a GitHub-hosted runner. It requires an exact stable SemVer/package match,
  a commit reachable from main, and successful `ci / package` and
  `agent-e2e / onboarding` checks from the Depot GitHub App for that commit.
  It waits up to 20 minutes for checks; a failed check stops publication.
- The publisher reproduces the tarball with the same pinned Node/npm versions
  and compares its integrity with Depot's evidence before publishing. No
  installation hooks run during packing or publication. The public registry
  tarball is downloaded and verified afterward.

Both CI jobs use the official Node.js 22.22.3 Linux distribution and npm 11.15.0.
A custom Node build can produce different gzip bytes even when the unpacked tar
contents match; use the same official distribution when reproducing locally.
The integrity gate deliberately rejects a different archive.

All push/PR testing stays in Depot. The GitHub publishing job does not run tests
again or need a Depot token, Doppler bootstrap token, or npm access token.

## One-time npm configuration

After the workflow is merged, open the package settings for
`@doomerlabs/doomer` on npm and add a GitHub Actions trusted publisher:

| Setting | Value |
| --- | --- |
| Organization/user | `doomerlabs` |
| Repository | `doomer-node` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed action | Direct publishing with `npm publish` |

Staging alone is insufficient for unattended publication: it would require a
human to approve every version. No access token or MFA secret is stored in CI.
The workflow requests `id-token: write`; npm exchanges that short-lived GitHub
identity for permission to publish this package. Repository, workflow, and
GitHub environment must match exactly. Configure the GitHub `npm` environment
and desired release/tag restrictions before the first release. Restrict its
deployment branches/tags to the intended release tags; add human reviewers only
if a separate release approval is wanted.

npm currently requires the first successful use of a new trusted-publisher
configuration within two days; configure it when ready to publish the next
version. Otherwise recreate the expired configuration. See the current
[trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
After validating OIDC publication, npm's “Require two-factor authentication and
disallow tokens” setting can keep personal publishes protected without blocking
trusted publishing. That settings change is separate from this PR.

## Release

1. Update `package.json` and `package-lock.json` to an unused stable SemVer;
   review and merge the change. Wait for main's Depot checks to pass.
2. Confirm the default stable Go download supports this installer before making
   a normal customer release. A Go beta does not update the stable channel.
3. Create an annotated `VERSION` tag at that exact main commit and push the tag.
   For example, an authorized `0.0.2` release uses `0.0.2`.
4. Follow the GitHub publishing job through registry verification. It publishes
   to `latest`. Merging this workflow does not authorize a release/tag push.

### Formalizing the initial 0.0.1

`releases/0.0.1.json` records the original manual publication's source commit,
archive integrity and every packaged file's digest and mode. Its hashes were
checked against that source commit and the public registry archive.

For the `0.0.1` tag, the workflow verifies the existing archive against this
receipt and verifies that the current tested package has the same runtime,
metadata, license and executable modes. Only README text may differ, because
CI documentation was added after the manual publication. It skips npm upload
and verifies the original registry bytes again. No new package contents or CI
provenance are retroactively claimed for that manual release.

A future runtime change still needs a new version; this receipt cannot permit
replacing `0.0.1`. Later releases use the normal exact-archive publication path.

Rerunning a job after a partial publication checks the existing npm integrity
and skips publication if it matches. Different bytes at the same version fail;
choose a new version for a correction. A new older version cannot move `latest`
backwards. If the version already exists, a retry only verifies it and leaves
all tags alone. Rollback/tag changes are deliberate separate operations.

The first npm publication may assign `latest` even when a different dist-tag was
requested; do not assume a dist-tag makes a public package private. Version
`0.0.1` is public and remains directly installable.
