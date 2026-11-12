# Doomer Node CLI

The Node.js CLI for Doomer Quick reviews. npm package: `@doomerlabs/doomer`.
Installed executable: `doomer`. The existing Go CLI, site, `install.md`, and
`doomer-review` skill are maintained separately.

## Install

Requires Node.js 22+, npm, and Git. Initial supported hosts: macOS and Linux.
Run setup in the environment where your agent edits code.

```sh
npx @doomerlabs/doomer install
```

Setup selects Claude Code, Codex, both, or standalone reviews, then:

1. Installs a persistent private copy of this package.
2. Replaces `~/.local/bin/doomer` with a link to it, backing up an existing
   command. Add `~/.local/bin` to `PATH` if absent.
3. Adds the global skill through the official skills CLI, equivalent to
   `npx skills add 'doomerlabs/skills#feat/doomer-node-skill' --skill doomer --global`. Skills.sh counts
   come from that CLI's telemetry; user telemetry settings are respected.
4. Installs agent hooks, preserving unrelated settings and hooks and backing
   up original configuration files.
5. Offers source-upload approval for the current repository separately.

Explicit agent selection supports noninteractive installation:

```sh
npx @doomerlabs/doomer install --agent claude,codex
npx @doomerlabs/doomer install --no-hooks
```

A human can add `--approve-uploads --repo /path/to/repo` to authorize uploads
for the selected agents and repository. Agents must not supply approval flags
without the user's authorization. Native hook trust is always user managed.

**Temporary testing source:** installation and updates currently fetch the skill
from `feat/doomer-node-skill`, so local testing does not require merging skills
PR #81. After that PR merges, change the source back to `doomerlabs/skills`.
Publish this package to npm before advertising the public install command.
For local testing from this checkout:

```sh
npm pack
node bin/doomer.js install --from "$PWD/doomerlabs-doomer-0.1.0.tgz"
```

## Installed the skill directly?

```sh
npx skills add 'doomerlabs/skills#feat/doomer-node-skill' --skill doomer --global
npx @doomerlabs/doomer onboard
```

Onboarding recognizes the existing global skill, installs the persistent CLI
if needed, and finishes hook setup. No files need to be committed to a project.
A global skill alone does not guarantee invocation; enabled, trusted hooks do
the work independently of skill discovery.

## Reviews

```sh
doomer review
doomer review --base origin/main --json
doomer review --wait none
doomer review get REVIEW_ID
```

Reviews call the existing Doomer workspace API directly from Node. No Go binary
is downloaded or invoked. This path requests only Quick/Look Closer, with Deep
disabled. Anonymous reviews use a private, persistent service-specific identity;
`DOOMER_TOKEN` can explicitly supply another credential.

Without saved approval, manual review prompts before uploading. A human may use
`--approve-upload` to approve that single invocation. Noninteractive review
without approval fails before any network request.

Snapshots include tracked and non-ignored untracked files, including staged and
unstaged edits. Git metadata is excluded. Symlinks, submodules, Git LFS pointers,
sparse checkouts, and merge conflicts are rejected. Initial limits are 20 MiB
per file, 256 MiB per tree, and 20,000 files. Source snapshots and the patch are
uploaded; do not include secrets in reviewed source. Review never modifies the
working tree or Git index.

The default baseline is the merge base with `origin/HEAD`, `main`, or `master`,
falling back to `HEAD`. `--base` selects another local commit. Identical
source/baseline pairs reuse the same review. Quick readiness is independent of
aggregate review status. Exit codes: 0 ready/no changes, 2 pending, 1 error.

## Hooks and maintenance

```sh
doomer doctor --json
doomer install-hooks --agent claude,codex
doomer update
doomer revoke --repo /path/to/repo
```

Hooks use global Claude `settings.json` and Codex `hooks.json`, respecting
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`. They call the persistent CLI by absolute
path, independent of `PATH` and skill discovery:

- `UserPromptSubmit` captures the working tree as the task baseline.
- `Stop` checks for changes and directly runs Quick review when that repository,
  service, and agent have upload approval. Findings return through a blocking
  hook response. Further edits are reviewed at the next stop.

Read-only turns with no source changes do not submit reviews. Hooks never invent
approval or modify native trust. Review/trust the definitions through the agent's
native controls and reload when needed. Cross-repository tool edits are not
tracked automatically in this initial version; review each edited repository
manually. Missing approval, timeouts, and failures must be reported as incomplete
reviews; hook failure does not prevent the host from continuing. A ready result
is delivered once per captured tree; the CLI does not certify that the agent
addressed every finding.

`doctor` inspects the actual skill, executable, and hooks. It reports saved
configuration separately from unverified native activation. `install-hooks`
repairs this Node CLI's hooks. `update` installs the latest npm package, updates
the skill through the skills CLI, and points configured hooks at the new runtime.
`revoke` removes saved agent-upload permission, not hosted reviews.

Private state, source baselines, and runtime versions live in
`${XDG_DATA_HOME:-~/.local/share}/doomer-node`. `DOOMER_HOME` changes this root;
`DOOMER_BIN_DIR` changes the command directory. Old runtime versions and backups
are retained for recovery. The old CLI's state is separate. Its `prepare`,
`task`, and `agent-hook` commands are not implemented here: keep legacy skills
and hooks on their original private runtime until retiring them.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

No runtime dependencies or install scripts. Tests use temporary Git repositories,
agent settings, a fake npm executable, and a loopback API. They do not upload to
the live service or alter your CLI. npm and skills.sh provide their own metrics;
no additional Doomer installation telemetry is implemented yet. Live-service and
native-agent acceptance testing remain release checks.

`docs/github-actions-ci.yml` is a ready-to-enable Node 22/24 and macOS/Linux
workflow. Move it to `.github/workflows/ci.yml` with a credential that has GitHub
workflow-write permission. The current repository push credential does not.

License: Apache-2.0.
