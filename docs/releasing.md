# Releasing: installers, signing and updates (D192)

A release is a git tag. Pushing `v0.2.0` runs `.github/workflows/release.yml`, which:
1. builds the installers on Windows (NSIS `.exe` and `.msi`), macOS (universal `.dmg`) and Linux
   (`.deb`, `.rpm`, `.AppImage`);
2. signs them when the secrets below are set;
3. publishes a **draft** GitHub release with `latest.json`, the file installed copies read to
   find updates.

Check the draft, write its notes (they appear in the update notification's "What's new"), and
publish it. Add the release's user-facing notes to `docs/release-notes.md` too: the IDE bundles
that file and opens it after an update (Help → Release notes).
Installed copies see it within a day, or straight away with Help → Check for updates….

## One-time setup

### 1. Update signing key (required for updates)
Updates are verified with a key pair, separately from Windows code signing:

```bash
npx tauri signer generate -w ~/.tauri/ide-updates.key
```

- In the repository's Settings → Secrets and variables → Actions:
  - secret `TAURI_SIGNING_PRIVATE_KEY`: the private key file's contents
  - secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password
  - variable `IDE_UPDATE_PUBKEY`: the public key
- Back up the private key. If it is lost, installed copies can no longer update; users would have
  to reinstall by hand.

Without these, the release builds don't update themselves and never connect anywhere. A build
made from source has no update endpoint either (`product.json` → `updates` is empty), so
development builds never check.

### 2. Windows code signing (so SmartScreen doesn't block people)
An unsigned installer gets "Windows protected your PC". Options as of October 2026 (Microsoft's
[code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)):

| Option | Cost | Who | SmartScreen |
|---|---|---|---|
| **Azure Artifact Signing** (formerly Trusted Signing) | about $10 a month | organizations in the US, Canada, EU and UK; individuals in the US and Canada; identity check takes a few days | builds reputation over consecutive signed releases; no hardware token; works in CI |
| OV certificate | $150–300 a year | anyone | same as above; the key must be on a hardware token or HSM, awkward in CI |
| EV certificate | $400+ a year | companies | no longer skips SmartScreen (since 2024), so not worth the premium |
| Microsoft Store (MSIX) | free | anyone | no warnings: the Store re-signs |

Artifact Signing is the recommended choice, and the workflow supports it.
1. Create an Artifact Signing account and a certificate profile in Azure, plus an App
   Registration with the "Artifact Signing Certificate Profile Signer" role.
2. Add the secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`.
3. Add the variables `AZURE_SIGNING_ENDPOINT` (e.g. `https://wus2.codesigning.azure.net`),
   `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`.

The Windows job then installs `artifact-signing-cli` and Tauri signs every binary and installer
with it (`bundle.windows.signCommand`, set by `scripts/gen.mjs` from `IDE_WINDOWS_SIGN_COMMAND`).
SmartScreen trust grows as people install signed releases. Sign every release with the same
identity.

### 3. macOS (optional)
Set the `APPLE_*` secrets (Developer ID certificate, notarization account). Without them the
`.dmg` is unsigned, and macOS asks users to approve it in System Settings.

### 4. Beta channel (optional, D204)
The setting `update.channel` ("stable" or "beta") picks where installed copies look. Stable is
this repository's latest release (`releases/latest/download/latest.json`; GitHub's "latest"
skips pre-releases). For beta, set the repository variable `IDE_UPDATE_BETA_ENDPOINT` to a
`latest.json` that beta builds are published to, for example a release with the fixed tag
`beta` whose `latest.json` you replace with each beta:
`https://github.com/<owner>/<repo>/releases/download/beta/latest.json`. The same signing key
signs both. Without the variable a build has no beta channel, and "beta" checks stable.

### 5. Problem reports (D204)
Help → Report a problem opens a new issue in the browser when product.json `issuesUrl` is set
(e.g. `https://github.com/<owner>/<repo>/issues`); without it, users copy the report or save it as
a zip.

## How updates work in the IDE
- `update.mode` decides when the IDE checks:
  - `default`: a minute after start, then once a day
  - `manual`: Help → Check for updates… only
  - `none`: never
- A newer version shows a notification with "Install and restart" and "What's new". Nothing is
  downloaded before the user chooses to install.
- Installing downloads the installer, verifies its signature against the build's public key,
  asks about unsaved files as closing the window does, installs it (on Windows the installer
  runs passively, with a progress bar) and restarts.
- `ide://update` shows the mode, the last check and an install in progress.
- In the code: the Rust side is `src-tauri/src/update` (`update_check`, `update_install`), and
  the updater plugin is registered only when the build has a public key. The frontend is
  `src/extensions/workbench/updates.ts`.

## Testing a release before tagging
Push a test tag (`v0.0.1-test.1`); the workflow makes a draft you can delete, with its tag.
Install the previous release, then publish a test release with a higher version, and check that
Help → Check for updates… finds and installs it.

The update signing key is given only to the build step, not to `npm ci` (whose packages run
install scripts).

## Audits and tests (contributors)
Every change runs `npm run check`, `npm test` and the Rust tests. The full command-script suite
(`npm run test:ui`) and an independent review of the changes run before each release. The
project's own cadence is to do both every two or three versions, and always before a tagged
release.
