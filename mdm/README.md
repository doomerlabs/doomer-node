# SimpleMDM pilot

In the Doomer organization, create a **Managed deployment** and select the seat tier and agent hooks. The key can enroll multiple users. An organization can use an existing active seat or an available paid seat for a new member. Organizations with complimentary early access use that existing entitlement.

Download `Doomer-MDM-VERSION.pkg` from
`https://downloads.doomer.ai/cli/releases/VERSION/`. Use the same package for
Apple Silicon and Intel Macs. Doomer CLI releases produce a Developer ID
Installer–signed product archive containing both agent integrations.

For a local build on macOS, use the package builder in the [Doomer CLI
repository](https://github.com/doomerlabs/doomer/tree/main/mdm) with a matching
release binary. The [CLI release documentation](https://github.com/doomerlabs/doomer/blob/main/docs/release.md#managed-macos-installer)
describes the signing and publication workflow.

In SimpleMDM, attach the package and the custom configuration profile to the pilot device group. Use [custom attributes](https://simplemdm.com/blog/custom-configuration-profiles-custom-attributes/) for the group-level `doomer_enrollment_key` and per-device `doomer_work_email`. Enable attribute support and deploy the profile at device scope. Set `ApiURL` to the candidate service's reachable HTTPS API, and keep the profile's agent list aligned with the Doomer deployment. The optional email domain restrictions live in Doomer. For this pilot, use Macs assigned to a single employee.

On the pilot Mac, start a fresh logged-in session and open a disposable repository in the selected coding agent. Confirm an ordinary edit produces a Quick Review link without Doomer setup prompts. Sign into Doomer with the assigned email and verify the link opens the review. A different member of the same organization should be denied. Confirm Deep Review uses the organization's entitlement and confirm the named seat and install in the organization dashboard.

The installer writes a system Codex hook configuration when selected and a Claude Code managed settings drop-in when selected. A higher-precedence Claude policy can require merging the generated hook and permission settings into that policy. Confirm the effective settings in the pilot. Starting a fresh Codex session after the login-time enrollment job ensures it reads the new scoped reviewer policy.

For enrollment errors, check the Mac's logs for `doomer-mdm` and verify profile attributes and available seats in Doomer. Rotating a deployment key affects subsequent enrollments and CLI credential renewal. Revoke an individual CLI credential from **Enrolled installs**. Removing the profile stops managed hooks on that Mac.
