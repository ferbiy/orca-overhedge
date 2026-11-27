# Installing the Overhedge build of Orca

[Українською](README.uk.md)

This fork is official [Orca](https://github.com/stablyai/orca) plus a small patch (see the
[fork README](../../../README.md) and [OVERHEDGE.md](../../../OVERHEDGE.md)). These guides explain
how to install it, keep it up to date, and go back to the previous or the official version.

| Guide                                     | For                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| [macOS desktop app](macos.md)             | Apple silicon Macs                                                                   |
| [Linux desktop app](linux-desktop.md)     | x86_64 Linux: `.deb` for Debian/Ubuntu, AppImage for other distros                   |
| [Orca server (headless)](server.md)       | an Ubuntu x86_64 host that runs `orca-ide serve` for a team, reached over VPN or SSH |
| [ClickUp Tasks plugin](clickup-plugin.md) | the desktop app (macOS or Linux) with the fork installed                             |

## Where builds come from

Every build is published on this fork's
[Releases page](https://github.com/ferbiy/orca-overhedge/releases). Nothing else is an official
source of the fork's builds.

- Tag: `v<upstream version>-overhedge.<n>`, for example `v1.4.278-overhedge.30`.
- Version inside the app or package: `<upstream version>+overhedge.<n>.g<commit>`, for example
  `1.4.278+overhedge.30.gbce58c734d`. The `+overhedge` part tells you it is this fork's build.

Files in a release:

| File                                                           | What                                             |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `orca-ide_<version>+overhedge.<n>.g<commit>_amd64.deb`         | Linux x86_64 package: the server and the desktop |
| `Orca-<version>_overhedge.<m>.g<commit>-mac-arm64.zip`         | macOS app, Apple silicon, ad-hoc signed          |
| `Orca-<version>_overhedge.<k>.g<commit>-linux-x86_64.AppImage` | Linux desktop app for non-Debian distros         |
| `SHA256SUMS`                                                   | sha256 of every file in the release              |

Not every release has every file: a release that changed only the server or Linux may have no mac
zip. Take each file from the newest release that has it. The mac zip and the AppImage carry their
own build counter (`<m>`, `<k>`); every file of one release is built from the same commit.

Always check the download against `SHA256SUMS` (each guide shows the command).

## Updates come from this fork, never from the official channel

The fork's desktop apps (macOS and Linux) have Orca's built-in updater turned off, so they never
replace themselves with an official release, which would drop the patch. "Check for updates" in
the app reports nothing; that is expected. A server package is never updated by Orca either.

To update, download the newer build from the Releases page and install it the same way as the
first time. Do not install an official Orca over the fork unless you mean to leave the fork (see
"Rollback" in each guide): your chats and settings stay, but the fork's features go away.

Releases never contain updater metadata (`latest*.yml`), and Orca's updater only reads
`stablyai/orca`, so it can never pick up a build from this repository either.

## Your data

The fork uses the same app id and the same data folders as official Orca
(`~/Library/Application Support/orca` on macOS, `~/.config/orca` on Linux, and `~/.orca`), so
switching between the official app and the fork keeps your chats, settings and plugins. Installing
a build of a much older upstream version than the one you ran may not read data written by the
newer one; back up first, as each guide shows.
