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
   `npx skills add 'doomerlabs/skills#018f0a4c0059859edcee4bd8e2f722dd03c80321' --skill doomer --global`. Skills.sh counts
   come from that CLI's telemetry; user telemetry settings are respected.
4. Installs agent hooks, preserving unrelated settings and hooks and backing
   up original configuration files.
5. Offers global source-upload approval separately: “Allow Doomer reviews to
   upload source snapshots to Doomer (https://doomer.ai)?”

After setup, the summary identifies the selected agents and whether source uploads are approved. Open `/hooks` in each agent to review and trust Doomer. Start a new session if the hooks have not loaded, then give the agent a small coding task. Doomer reviews the changes automatically; a completed review verifies activation. Declining uploads keeps automatic reviews off without undoing installation.

The installer also downloads the Go CLI from the official stable channel and
verifies its archive checksum. It installs versioned executables beside a `~/.local/bin/doomer` symlink, for
example `doomer-2026.11.12.1`. Updates atomically switch the symlink, so running
watches finish on the old executable while new watches use the new one.
For a development build, set `DOOMER_NATIVE_BINARY` to the Go executable you
built. In the default profile, the installer saves local builds as
`~/.local/bin/doomer-dev` and points `doomer` at that file. In explicit
development mode (`DOOMER_DEV_INSTALL=1`), only `doomer-dev` is replaced;
production `doomer` is preserved. These profiles cannot both own the same local
build: keep production on a released binary before adding development mode.

Automatic reviews require a Go CLI with the foreground `watch` command and
`watch agent-hook`. An older release may support manual reviews while doctor
reports automatic reviews unavailable. Use a compatible released CLI, or an
explicitly selected candidate for authorized source testing.

Explicit agent selection supports noninteractive installation:

```sh
npx @doomerlabs/doomer install --agent claude,codex
npx @doomerlabs/doomer install --no-hooks
```

A human can add `--approve-uploads` to authorize all Doomer review uploads to
the configured service, across repositories and agents. Agents must not supply approval flags
without the user's authorization. Native hook trust is always user managed.

The installer pins a reviewed skill commit in `src/skill-source.js`; it does not
follow a moving feature branch. Update that pin only alongside onboarding
validation. Registry installation requires this package to be published.
For local testing from this checkout, the installer automatically persists the
package you are running. No npm publication, manual pack, or `--from` is needed:

```sh
npx . install
# Or run your current source directly:
node bin/doomer.js install
```

## Installed the skill directly?

```sh
npx skills add 'doomerlabs/skills#018f0a4c0059859edcee4bd8e2f722dd03c80321' --skill doomer --global
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

Run reviews directly with the installed Go CLI, `doomer`. The Node manager
only installs and configures Doomer; it does not run or delegate reviews.
Use `doomer review --help` for review options, upload permission, and result handling.

## Diagnose setup

Run `npx @doomerlabs/doomer doctor` for a readable diagnosis. `--json` includes structured `issues`, `next`, `uploadApproved` and `activation`. `ready` means installed configuration; it does not prove hook trust, upload consent or a completed review.

Missing CLI or skill: rerun `onboard`. Missing hooks: run `install-hooks --agent codex` (or `claude`). Disabled hooks or invalid settings: follow the reported settings-file action; repair preserves those user choices. PATH conflicts: use the reported absolute executable or fix PATH instead of reinstalling. Missing upload approval: rerun `onboard` and review the consent prompt. Setup errors name the failed step and provide a command to resume after fixing it.

For an expired account login, use `doomer login --device` for the same service and profile. For unavailable or rate-limited service, retain any review ID and retry later. Never report a failed request as a completed review. `doomer support bundle` saves local diagnostics; `--upload` explicitly shares them.

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
The Go hook reads saved upload approvals. It uses `DOOMER_API_URL` and
`DOOMER_TOKEN` from the agent environment when set, and reads the account
credentials from the service-specific configuration directory saved during onboarding:

- `UserPromptSubmit` starts `doomer watch` for that agent session and turn.
  The hook controls its lifetime; watch discovers repositories recursively.
- The watcher keeps snapshots, pending requests, and results in memory. It does
  not create runtime JSON, PID files, lock directories, or disk upload caches.
- `Stop` drains the final changes, returns the results, and exits that watcher.
  Codex `Interrupt` and Claude `SessionEnd` also stop their watches.
- Linux watchers use abstract Unix sockets with no filesystem entry. macOS uses
  temporary socket endpoints that are removed when the watcher exits.

You can also run `doomer watch /path/to/workspace` directly. It watches until you
stop it with Ctrl+C or SIGTERM and prints review results as JSON.

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
with `npm pack` and run `npx --yes ./doomerlabs-doomer-VERSION.tgz uninstall`.

Uninstall disables the managed hooks, stops its native watchers, removes the
global `doomer` link when it still points to a managed executable, removes the
new global `doomer` skill, and deletes the private runtimes, source snapshots,
credentials, and local installation state. It does not remove hosted reviews,
the old `doomer-review` skill, unrelated agent settings, or recovery backups.
If you replaced the global command yourself, uninstall reports and preserves
that replacement. Uninstall reloads removed hooks in a reachable local Codex
server and reports when a restart is required instead.

Installed binaries, saved approvals, credentials, and manager versions live in
`${XDG_DATA_HOME:-~/.local/share}/doomer-node`. `DOOMER_HOME` changes this root;
`DOOMER_BIN_DIR` changes the command directory. Old manager versions and backups
are retained for recovery; turn state and source snapshots stay in memory. The old CLI's state is separate. Its `prepare`,
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

Depot runs package checks and the pinned shared `doomerlabs/agent-e2e` runner
on main pushes and pull requests. Test credentials stay in Doppler
`doomer/test`. GitHub Actions handles only numeric release tags, publishing through
npm trusted publishing after verifying Depot checks and the tested tarball.
See [npm publishing](docs/npm-publishing.md) for setup and release instructions,
and [release preparation](docs/release-preparation.md) for the customer rollout.

License: Apache-2.0.

## Development VM installation

For a VM that already has a production installation, provision the following
only in the local Node checkout's shell environment:

```sh
export DOOMER_DEV_INSTALL=1
export DOOMER_NATIVE_BINARY="$HOME/workspace/doomer/bin/doomer"
export DOOMER_HOOK_ROOT="$HOME/test-apps"
export DOOMER_API_URL=http://localhost:3000/api
export DOOMER_CONFIG_DIR="$HOME/.doomer-developer/doomer-testing"
unset DOOMER_TOKEN
```

Then `npm pack && npx . install` installs the local binary as
`~/.local/bin/doomer-dev`, keeps state in `~/.local/share/doomer-node-dev`, and
adds development-owned hooks. Production's `doomer` executable, installer state,
and hooks are preserved. Reinstalling either profile preserves the other's hook
positions so Codex trust keys do not alternate. Uninstalling development keeps
the shared skill used by production. Uninstalling production also preserves
the shared skill while a development installation remains.

The development hooks require the Go CLI's `--watch-root` support. That Go patch
is currently paused and uncommitted, so this scoped setup is not yet available
from the published branch. The instructions below apply once that dependency
is committed and you build it yourself. Provision production hooks with
`DOOMER_HOOK_ROOT="$HOME/workspace"` and development mode unset, so the two hook
sets watch disjoint directory trees. Both sets call Go directly. A chat rooted
above both trees starts one scoped watcher for each tree. New or changed hook
definitions still require native trust once; environment switching does not
rewrite them.

To replace a saved production hook scope, set `DOOMER_HOOK_ROOT` to the new
directory and rerun onboarding. Set `DOOMER_HOOK_ROOT=` to clear it. Development
hooks still require a scope; `--no-hooks` can install without one.

`doomer upgrade` delegates a Node-managed CLI to this manager's `upgrade` command.
Unlike `update`, `upgrade` changes only the native executable: it does not install
skills, change agent selection, rewrite hooks, or grant upload permission. Use
`upgrade --check --json` to inspect the latest release without writing local state.
Development/local candidate binaries remain user-managed.
