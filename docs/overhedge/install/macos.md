# macOS: install the Overhedge build of Orca

[Українською](macos.uk.md) · [All install guides](README.md)

The fork's macOS app is the same Orca desktop app as the official one, built from this fork. It
keeps your chats, settings and plugins, because it uses the same app id and the same data folders
(`~/Library/Application Support/orca` and `~/.orca`).

What to know first:

- **Apple silicon only** (arm64). There is no Intel build.
- **Ad-hoc signed, not notarised.** The fork has no Apple Developer ID, so macOS treats the app as
  coming from an unidentified developer. You remove the quarantine flag once per install (step 4).
- **Updates are off.** The app never updates itself, and never to an official release. New builds
  come only from this fork's [Releases page](https://github.com/ferbiy/orca-overhedge/releases);
  you install each one by hand, as below.
- **Keychain prompt.** On first launch macOS asks for access to the "Orca Safe Storage" keychain
  item. Choose **Always Allow**. Each new build asks once more, because an ad-hoc signature changes
  with every build.

## 1. Download

Find the newest release that has a `*-mac-arm64.zip` on the
[Releases page](https://github.com/ferbiy/orca-overhedge/releases) (a release that changed only the
server or Linux may not have one). Download the zip and `SHA256SUMS` from it, in a browser or with
the GitHub CLI:

```bash
mkdir -p ~/Downloads/orca-overhedge && cd ~/Downloads/orca-overhedge
TAG=v1.4.278-overhedge.28          # the release you picked
gh release download "$TAG" -R ferbiy/orca-overhedge -p '*-mac-arm64.zip' -p 'SHA256SUMS'
# without gh: curl -LO https://github.com/ferbiy/orca-overhedge/releases/download/$TAG/<file name>
```

## 2. Verify the checksum

```bash
cd ~/Downloads/orca-overhedge
shasum -a 256 -c SHA256SUMS --ignore-missing
# Orca-<version>_overhedge.<m>.g<commit>-mac-arm64.zip: OK
```

Do not install a file that does not print `OK`.

## 3. Quit Orca and keep the current app

1. Quit Orca completely: **Orca › Quit Orca** (Cmd-Q), not just closing the window. Check that it
   is gone:

   ```bash
   pgrep -x Orca || echo "Orca is not running"
   ```

2. Keep the app you have now, so you can go back to it:

   ```bash
   mv /Applications/Orca.app "/Applications/Orca-previous.app"
   ```

   If you are coming from the official app, a name like `Orca-official-1.4.278.app` helps later.

3. Optional, but recommended before switching between upstream versions: back up your data
   (it can be several GB):

   ```bash
   tar -C ~ -czf ~/orca-backup-$(date +%F).tgz "Library/Application Support/orca" .orca
   ```

## 4. Install

```bash
cd ~/Downloads/orca-overhedge
rm -rf unzipped && ditto -x -k Orca-*-mac-arm64.zip unzipped
xattr -dr com.apple.quarantine unzipped/Orca.app   # otherwise Gatekeeper refuses the unsigned app
mv unzipped/Orca.app /Applications/Orca.app
open /Applications/Orca.app
```

If there is more than one zip in the folder, use its full name instead of `Orca-*-mac-arm64.zip`.

## 5. First launch

- **Keychain:** macOS asks for your login password so Orca can use "Orca Safe Storage". Enter it
  and choose **Always Allow**. If you choose Deny, the secrets Orca encrypted (saved API keys,
  connector and plugin tokens) cannot be read in that run; nothing is deleted. Quit, start again and
  allow. Claude Code's own login is not affected.
- **macOS permissions** (Files and Folders, Accessibility, Screen Recording for computer use,
  notifications) are tied to the app's signature and may need granting again.
- Check the version: Orca › About Orca (or Settings) shows `<version>+overhedge.<n>.g<commit>`.

## Update to a newer build

Repeat steps 1 to 5 with the newer zip. Keep the build you are replacing (for example as
`Orca-previous.app`) until the new one works, then delete the old copy. Expect the keychain prompt
again.

"Check for updates" in the app reports nothing. That is expected: the official update channel is
off in the fork, and updates come only from this fork's Releases page.

## Rollback

**To the previous build** (fork or official), with Orca quit:

```bash
rm -rf /Applications/Orca.app
mv "/Applications/Orca-previous.app" /Applications/Orca.app
open /Applications/Orca.app
```

**To official Orca:** quit Orca and install the official app from
[stablyai/orca releases](https://github.com/stablyai/orca/releases) (`orca-macos-arm64.dmg`) or
[orca.dev](https://orca.dev). It opens the same data. From then on it updates itself from the
official channel, and the fork's features go away: per-chat account pins are ignored, `/rc` and
the fork's chat commands are gone, and the ClickUp plugin's Tasks tab and Send to chat stop
working (official Orca does not load a plugin that asks for `chat:send`).

Going back to a much older upstream version than the one you ran may not show everything written
by the newer one. In that case restore the backup from step 3 with Orca quit:
`tar -C ~ -xzf ~/orca-backup-<date>.tgz`.

## Troubleshooting

**"Orca is damaged and can't be opened. You should move it to the Trash."** The quarantine flag is
still set (the app was unzipped by Finder or Safari, or copied again). Run:

```bash
xattr -dr com.apple.quarantine /Applications/Orca.app
```

**"Orca cannot be opened because the developer cannot be verified"** or **"Apple could not verify
Orca is free of malware".** Remove the quarantine flag as above. If macOS still blocks it, open
System Settings › Privacy & Security, scroll to the message about Orca and choose **Open Anyway**,
or Control-click the app in Finder and choose **Open**.

**The app quits at once or "is not supported on this Mac".** The build is arm64 only; it does not
run on an Intel Mac.

**The keychain asks again and again.** Choose **Always Allow**, not Allow. One prompt per new build
is expected.

**Saved keys or plugin sign-ins are missing.** You probably chose Deny at the keychain prompt.
Quit, start Orca again and choose Always Allow; nothing was lost.

**Orca offers an official update, or replaced itself.** That cannot happen with a fork build; check
the version in About. If it has no `+overhedge`, you are running the official app: install the
fork again from this fork's Releases page.
