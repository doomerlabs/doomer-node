# Doomer Node CLI

The management CLI for Doomer. npm package: `@doomerlabs/doomer`.
The globally installed `doomer` executable is the Go CLI. This npm package runs
as `npx @doomerlabs/doomer` to manage it. The Go CLI handles filesystem watching, source
capture, uploads, and Quick reviews. The site, old installer, and `doomer-review`
skill remain separate.

## Install

Requires Node.js 22+, npm, and Git. Initial supported hosts: macOS and Linux.
Run setup in the environment where your agent edits code.

Set `DOOMER_API_URL=http://localhost:3000/api` before setup and before launching
your agent to default a development environment to the local service. Selection
order is `--api-url`, `DOOMER_API_URL`, the saved endpoint, then
`https://doomer.ai/api`. Upload approval remains specific to the service.
Already running watchers retain their original endpoint; revoke that endpoint
before switching if you want them stopped.

```sh
npx @doomerlabs/doomer install
```

Setup selects Claude Code, Codex, both, or standalone reviews, then:

1. Installs a persistent private copy of the manager and the native Go CLI.
2. Replaces `~/.local/bin/doomer` with a link to the Go CLI, backing up an existing
   command. Add `~/.local/bin` to `PATH` if absent.
3. Adds the global skill through the official skills CLI, equivalent to
   `npx skills add 'doomerlabs/skills#feat/doomer-node-skill' --skill doomer --global`. Skills.sh counts
   come from that CLI's telemetry; user telemetry settings are respected.
4. Installs agent hooks, preserving unrelated settings and hooks and backing
   up original configuration files.
5. Offers global source-upload approval separately: “Allow Doomer reviews to
   upload source snapshots to Doomer (https://doomer.ai)?”

The installer also downloads the Go CLI from the official stable channel and
verifies its archive checksum. It keeps the Go executable privately as
`doomer-node/bin/doomer-go`; the public `doomer` command points to that Go binary.
For a development build, set `DOOMER_NATIVE_BINARY` to the Go executable you
built. The installer copies it into its private runtime.

The two-hook integration requires a Go build with `watch --all-changes` and `watch agent-hook`, on the
`feat/watch-all-changes` branch until released. An older stable release can run
manual reviews, but doctor reports automatic reviews unavailable rather than
silently claiming the watcher is ready.

Explicit agent selection supports noninteractive installation:

```sh
npx @doomerlabs/doomer install --agent claude,codex
npx @doomerlabs/doomer install --no-hooks
```

A human can add `--approve-uploads` to authorize all Doomer review uploads to
the configured service, across repositories and agents. Agents must not supply approval flags
without the user's authorization. Native hook trust is always user managed.

**Temporary testing source:** installation and updates currently fetch the skill
from `feat/doomer-node-skill`, so local testing does not require merging skills
PR #81. After that PR merges, change the source back to `doomerlabs/skills`.
Publish this package to npm before advertising the public install command.
For local testing from this checkout, the installer automatically persists the
package you are running. No npm publication, manual pack, or `--from` is needed:

```sh
npx . install
# Or run your current source directly:
node bin/doomer.js install
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
doomer review --base origin/main --format json
doomer review --wait none
doomer review get REVIEW_ID --workspace
```

Reviews are delegated to the installed Go CLI. The manager requests
Quick/Look Closer with Deep disabled. Anonymous reviews use a private,
persistent service-specific identity;
`DOOMER_TOKEN` can explicitly supply another credential.

Without saved approval, manual review prompts before uploading. A human may use
`--approve-upload` to approve that single invocation. Noninteractive review
without approval fails before any network request.

Snapshots include tracked and non-ignored untracked files, including staged and
unstaged edits. Git metadata is excluded. Symlinks, submodules, Git LFS pointers,
sparse checkouts, and merge conflicts are rejected. Limits and capture behavior
are defined by the Go CLI. Source snapshots and the patch are
uploaded; do not include secrets in reviewed source. Review never modifies the
working tree or Git index.

The default baseline is the merge base with `origin/HEAD`, `main`, or `master`,
falling back to `HEAD`. `--base` selects another local commit. Quick readiness is
independent of aggregate review status. JSON results use the Go CLI's output
format. Manual review submission and result handling follow that CLI.

## Hooks and maintenance

```sh
npx @doomerlabs/doomer doctor --json
npx @doomerlabs/doomer install-hooks --agent claude,codex
npx @doomerlabs/doomer refresh-hooks
npx @doomerlabs/doomer update
npx @doomerlabs/doomer revoke
```

Hooks use global Claude `settings.json` and Codex `hooks.json`, respecting
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`. They call the persistent CLI by absolute
path, independent of `PATH` and skill discovery. They execute the Go binary
directly using `watch agent-hook`; Node is only used for management commands.
The Go hook reads saved upload approvals and inherits `DOOMER_API_URL` and
`DOOMER_TOKEN` from the agent environment:

- `UserPromptSubmit` starts or reuses a detached Go watcher and forwards the
  prompt and session context. The Go watcher observes the filesystem and reviews
  all settled changes, including manual edits and other processes' changes.
- `Stop` asks the Go hook to capture the latest state and wait for Quick results.
  Findings return through its native blocking hook response.

Pre/post-tool hooks are not installed or invoked by this flow. Repair removes
only this Node installer's old tool-hook entries, preserving other hooks.

Clean trees with no diff do not submit reviews. Hooks never invent
approval or modify native trust. Review/trust the definitions through the agent's
native controls. Setup prints the exact hook file path and asks the running
local Codex server to reload it without restarting the session. This uses the
existing Unix control socket and an empty `config/batchWrite` request with
`reloadUserConfig: true`; it does not change settings or trust decisions.
`refresh-hooks` runs the same operation on demand. If no compatible local server
is reachable, the CLI explicitly reports that a restart is needed.
`DOOMER_CODEX_SOCKET` can specify a non-default local control socket.
Cross-repository tool edits are not
tracked automatically in this initial version; review each edited repository
manually. Missing approval, timeouts, and failures must be reported as incomplete
reviews; hook failure does not prevent the host from continuing. A ready result
is delivered once per captured tree; the CLI does not certify that the agent
addressed every finding.

`doctor` inspects the actual skill, executable, and hooks. It reports saved
configuration separately from unverified native activation. `install-hooks`
repairs this Node CLI's hooks. `update` installs the latest npm package, updates
the skill through the skills CLI, and updates the native CLI.
`revoke` removes saved upload permission for the configured service, not hosted
reviews. Legacy repository-specific approvals retain their original scope;
onboard again to accept the new global permission.

## Uninstall

```sh
npx @doomerlabs/doomer uninstall
```

From an unpublished checkout, use `node bin/doomer.js uninstall` or package it
with `npm pack` and run `npx --yes ./doomerlabs-doomer-0.1.0.tgz uninstall`.

Uninstall disables the managed hooks, stops its native watchers, removes the
global `doomer` link when it still points to a managed executable, removes the
new global `doomer` skill, and deletes the private runtimes, source snapshots,
credentials, and local installation state. It does not remove hosted reviews,
the old `doomer-review` skill, unrelated agent settings, or recovery backups.
If you replaced the global command yourself, uninstall reports and preserves
that replacement. Uninstall reloads removed hooks in a reachable local Codex
server and reports when a restart is required instead.

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

The `ws` runtime dependency provides the Unix-socket WebSocket connection to
Codex. There are no package install scripts. Tests use temporary Git repositories,
agent settings, mock Codex WebSocket servers, and fake npm/native executables. They do not upload to
the live service or alter your CLI. npm and skills.sh provide their own metrics;
no additional Doomer installation telemetry is implemented yet. Live-service and
native-agent acceptance testing remain release checks.

`docs/github-actions-ci.yml` is a ready-to-enable Node 22/24 and macOS/Linux
workflow. Move it to `.github/workflows/ci.yml` with a credential that has GitHub
workflow-write permission. The current repository push credential does not.

License: Apache-2.0.
