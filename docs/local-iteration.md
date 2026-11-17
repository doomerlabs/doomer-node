# Test local changes on another machine

The `doomer`, `doomer-node`, and `skills` repositories are public. Unpushed changes are available only in the source bundle created on the development machine. No Doomer npm publication or Git push is required.

## Create a source bundle

Keep the three checkouts side by side. On the development machine, run:

```sh
python3 doomer-node/scripts/bundle-local.py /tmp/doomer-local-001.tar.gz
```

Use a new output filename for each bundle. It includes tracked and non-ignored untracked source, including local edits, and omits deleted files, Git metadata, `.env` files, and dependencies. Never put credentials in source files. Copy this archive to the test machine over your existing SSH connection or another trusted file-transfer channel. Extract each bundle into a fresh directory so deleted files from an earlier bundle cannot linger.

## Leave production on the test machine

Finish the active Claude task and close that session first. In the same environment used for its production installation, run:

```sh
npx @doomerlabs/doomer@beta revoke --api-url https://doomer.ai/api
doomer --api-url https://doomer.ai/api logout
```

Revoking stops saved production upload approval; logging out revokes the account token and removes its local copy. Neither command deletes hosted reviews. If production cannot be reached, `logout --local-only` removes local login state without revoking the remote token. Do not use it as evidence of remote revocation.

Remove production overrides from your shell startup, direnv, or launcher. In particular, unset `DOOMER_TOKEN`; an inherited token overrides saved credentials. You can reuse the normal installation: no separate production profile is needed for this workflow.

## Install the source bundle

Requires macOS or Linux, Node.js 22+, npm, Git, make, and the Go version required by `doomer/go.mod`. The source installer builds the CLI on the test machine, installs the local Node package and bundled skill, and configures your selected agent. npm still downloads dependencies and the official skills installer; it does not download a published Doomer package.

```sh
mkdir doomer-local-001
cd doomer-local-001
tar -xzf /path/to/doomer-local-001.tar.gz
cd doomer-local
bash doomer-node/scripts/install-local.sh https://YOUR-DEVELOPMENT-HOST/api claude
```

Use the reachable HTTPS origin of the development server. `localhost` on the test machine refers to that machine, unless you deliberately set up a tunnel. The script validates the URL, clears inherited tokens, and uses a dedicated local-testing credential directory. It replaces the normal user's Doomer installation with the source build; it does not keep a second production installation. Set `DOOMER_LOCAL_HOME`, `DOOMER_LOCAL_BIN_DIR`, or `DOOMER_LOCAL_CONFIG_DIR` before running if your original installation uses custom paths.

Review source-upload consent and Claude review-command permission when prompted. Open `/hooks` and trust the configured hooks, then start a new Claude session. The installer does not make those trust decisions.

## Log in and launch Claude

Use the same service and credential directory for login and for the agent environment:

```sh
unset DOOMER_TOKEN
export DOOMER_API_URL=https://YOUR-DEVELOPMENT-HOST/api
export DOOMER_CONFIG_DIR="$HOME/.config/doomer-local-testing"
"$HOME/.local/bin/doomer" --api-url "$DOOMER_API_URL" login --device
claude
```

Adjust paths if you used the `DOOMER_LOCAL_*` overrides. Complete device login in the development service's browser page, not the production site. Account login and upload permission are separate; quick reviews can also run without account login.

The API URL is saved by setup, but pass it in the agent environment as shown to avoid inheriting a production override. Persist these exports only in the launcher or shell you intend to use for testing.

## Get the next iteration

Create and copy a new bundle, extract into a fresh directory, close the previous Claude session, and run the same `install-local.sh` command. No uninstall is needed. The manager replaces its private package when source changes, installs the new native binary atomically, and refreshes the bundled skill. Start a new Claude session and verify a small real review. Do not use `update` for this loop: it follows the published npm distribution.

## Saved HTTPS updater for polish-part-2

Save `scripts/sync-local.sh` as `~/update-doomer.sh` on the test machine and run `bash ~/update-doomer.sh`. It downloads the current source bundle from `https://dev-5e07a07af5ee.exe.xyz/local-builds/polish-part-2/source.tar.gz`, builds and installs locally, then removes temporary source. No GitHub or SSH login is needed.

The developer refreshes this bundle after local changes. The URL serves the latest published local snapshot, including uncommitted changes, rather than a GitHub branch. `DOOMER_TEST_ORIGIN` and `DOOMER_TEST_AGENTS` override the HTTPS host and agent selection.

On the development machine, run `scripts/publish-local.sh` to refresh the bundle and updater on the sibling development site's public directory. This explicitly publishes source from these public repositories; it excludes Git metadata, dependencies, and environment files. Verify the branch and inspect source before publishing. Nothing is pushed to GitHub or npm.
