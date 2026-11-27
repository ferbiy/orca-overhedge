# ClickUp Tasks plugin: install

[Українською](clickup-plugin.uk.md) · [All install guides](README.md)

[ClickUp Tasks](https://github.com/ferbiy/orca-clickup-tasks) brings your ClickUp tasks into Orca:
a sidebar panel, and on the fork a ClickUp tab on the Tasks page (list or board), Start in a
worktree, and Send to chat. Its README covers every feature, the permissions and the ClickUp OAuth
app setup; this page is the install path.

## Before you start

- **The fork's desktop app**, macOS or Linux ([macOS](macos.md), [Linux](linux-desktop.md)). The
  Tasks page tab and Send to chat exist only in the fork, and the plugin's current versions ask for
  the fork-only `chat:send` capability, so official Orca refuses to install them.
- **Plugins run in the desktop app**, not on a server. With the desktop paired to an Orca server,
  the plugin still runs on your computer and can start tasks in the server's projects.
- **A working OS keychain**: macOS Keychain, or on Linux GNOME Keyring or KWallet (see
  [Linux keyring](linux-desktop.md#keyring-secret-storage)). The plugin keeps its ClickUp token
  there through Orca.

## 1. Install a pinned version

Install a release tag or a full commit SHA of the plugin repo, never the community catalog listing
and never a branch. Use the version your team names, or the newest release on the plugin's
[Releases page](https://github.com/ferbiy/orca-clickup-tasks/releases) (for example `v0.5.0`).
Orca must be running.

The CLI is `orca` on macOS and `orca-ide` from the Linux `.deb`; the commands are the same.

```bash
orca plugin install ferbiy/orca-clickup-tasks@<tag-or-sha> --json
```

Without `--approve` nothing is installed. The command exits with code 3 (`approval_required`) and
prints what the plugin will get (its capabilities: workspace, notifications, secrets, `chat:send`
and so on), the publisher and the repository, and the exact command with `--approve
<fingerprint>`. Read the list; if it matches the plugin's README, approve:

```bash
orca plugin install ferbiy/orca-clickup-tasks@<tag-or-sha> --approve <fingerprint> --json
```

The plugin installs as `ferbiy.clickup-tasks`. If the upstream `gthjnk.clickup-tasks` is installed,
remove it first so there is one ClickUp panel:

```bash
orca plugin uninstall gthjnk.clickup-tasks
```

## 2. Turn off plugin auto-update

**Settings › Plugins › turn off "Update plugins automatically"** (also in the "Plugin settings"
menu on the Plugins page). A pinned install never updates by itself anyway (`orca plugin update`
lists it as `pinned`); the switch makes sure no catalog plugin changes without you either.

## 3. Sign in

Open the **ClickUp Tasks** panel and sign in, either with OAuth through your own ClickUp OAuth app
(set up once, see
[Connect](https://github.com/ferbiy/orca-clickup-tasks/tree/overhedge#connect-create-your-clickup-oauth-app-once)
in the plugin README) or with a personal API token (ClickUp › Settings › Apps › API Token). Then
choose in **Settings › Lists** which Spaces, Folders or Lists Orca may see. Nothing is fetched
until you do.

## Update the plugin

Install the newer tag or commit with the same two commands (step 1). The approval step shows the
access list again; check it for new capabilities.

## Troubleshooting

**The install is refused because of `chat:send`.** You are running official Orca. Install the
fork's desktop app first.

**There is no ClickUp tab on the Tasks page.** Check that the app is the fork (About shows
`+overhedge`), the plugin is enabled, and you are signed in.

**The plugin keeps asking to sign in, or cannot save the token.** The keychain is not available: on
macOS choose Always Allow at the "Orca Safe Storage" prompt; on Linux unlock the keyring or start
Orca with `--password-store=gnome-libsecret` (see
[Linux keyring](linux-desktop.md#keyring-secret-storage)).
