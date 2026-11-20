# SimpleMDM pilot

In the Doomer organization, create a **Managed deployment** and select the seat tier and agent hooks. The key can enroll multiple users. An organization can use an existing active seat or an available paid seat for a new member. Organizations with complimentary early access use that existing entitlement.

On the [Doomer releases page](https://github.com/doomerlabs/doomer/releases),
choose the newest release whose tag starts with `mdm-bootstrap-`. Use the
version after the prefix as `VERSION` in the attached
`Doomer-MDM-Bootstrap-VERSION.pkg`. This version is independent of the
runtime version delivered by the CLI channel. If the first dedicated release
is still pending, existing channel-enabled bootstraps can stay assigned and
continue receiving verified runtime updates.

Download the package and `checksums.txt` from that same release into an
empty directory. On a Mac, run the following from that directory and confirm
both checks pass. The signature output must report an Apple-trusted
distribution signature and list
`Developer ID Installer: Marc Campbell (SVB2S5YXF4)` as the leaf signer.

```sh
/usr/bin/shasum -a 256 -c checksums.txt
/usr/sbin/pkgutil --check-signature Doomer-MDM-Bootstrap-*.pkg
```

Upload this universal bootstrap once for Apple Silicon and Intel Macs.
After installation, the downloader waits for active MDM enrollment and the
device profile. It verifies and installs the managed runtime selected by the
channel. The hooks can run after the first runtime is activated and the
employee enrolls. The Mac then checks every six hours with up to one hour of
jitter.

For the pilot, confirm that `managed_package.version` exists in the selected
[beta CLI feed](https://downloads.doomer.ai/cli/beta.json) or
[stable CLI feed](https://downloads.doomer.ai/cli/stable.json). That field
appears only after the CLI release job publishes and verifies the signed
runtime and its manifest. If it is absent, use a channel that has a managed
package or wait for publication. The updater reports the missing package
on the Mac. Fresh Macs wait for a verified runtime, and existing installs
keep their current runtime.

An existing managed Mac with the channel updater can continue receiving
updates from its feed. If it predates channel updates, assign the new
bootstrap to the existing MDM device. The bootstrap preserves its Doomer
credential and work email.

For local package rehearsal on macOS, see the CLI repository's
[bootstrap build script](https://github.com/doomerlabs/doomer/blob/main/mdm/build-bootstrap-binary.sh)
and [release documentation](https://github.com/doomerlabs/doomer/blob/main/docs/release.md#managed-macos-installer).
An unsigned local bootstrap is for package and launcher checks. It does
not bypass runtime signature verification. Use the signed releases above
for an end-to-end pilot.

In SimpleMDM, attach the package and the custom configuration profile to the
pilot device group. Set the group-level `doomer_enrollment_key` and
`doomer_channel` [custom attributes](https://simplemdm.com/blog/custom-configuration-profiles-custom-attributes/).
Set `doomer_channel` to `beta`, `stable`, or `manual`. A missing
`UpdateChannel` preference defaults to `beta`.

If the Mac already has an `email_address` attribute containing the assigned
engineer's work email, reuse it. In your copy of the profile template, change
the `WorkEmail` value from `{{doomer_work_email}}` to `{{email_address}}`.
You can also use `doomer_work_email` with the template as supplied. Confirm
the chosen attribute is populated on each pilot Mac.

Enable attribute support and deploy the profile at device scope. Set `ApiURL`
to the candidate service's reachable HTTPS API, and keep the profile's agent
list aligned with the Doomer deployment. The optional email domain
restrictions live in Doomer. For this pilot, use Macs assigned to a single
employee.

On the pilot Mac, start a fresh logged-in session and open a disposable repository in the selected coding agent. Confirm an ordinary edit produces a Quick Review link without Doomer setup prompts. Sign into Doomer with the assigned email and verify the link opens the review. A different member of the same organization should be denied. Confirm Deep Review uses the organization's entitlement and confirm the named seat and install in the organization dashboard.

The installer writes a system Codex hook configuration when selected and a Claude Code managed settings drop-in when selected. A higher-precedence Claude policy can require merging the generated hook and permission settings into that policy. Confirm the effective settings in the pilot. Starting a fresh Codex session after the login-time enrollment job ensures it reads the new scoped reviewer policy.

For enrollment errors, check the Mac's logs for `doomer-mdm` and verify profile attributes and available seats in Doomer. Rotating a deployment key affects subsequent enrollments and CLI credential renewal. Revoke an individual CLI credential from **Enrolled installs**. Removing the profile stops managed hooks on that Mac.

For manual updates in SimpleMDM, set the group-level `doomer_channel`
attribute to `manual`. Keep `{{doomer_channel}}` in the profile template so
SimpleMDM populates `UpdateChannel`. Once the profile applies, IT can select
the package channel for each run on the Mac:

- Beta: `sudo /Library/DoomerMDM/run-doomer mdm update --channel beta`
- Stable: `sudo /Library/DoomerMDM/run-doomer mdm update --channel stable`

The [two-release pilot guide](https://doomer.ai/docs/installation/managed-deployments#verify-automatic-updates-across-two-releases)
shows how to verify the same MDM upload during fresh installation and a
subsequent update.
