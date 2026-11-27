# Linux desktop: install the Overhedge build of Orca

[Українською](linux-desktop.uk.md) · [All install guides](README.md)

The fork's Linux desktop app is the same Orca (Electron) app as the official one, built from this
fork. It has the fork's features (the ClickUp plugin's Tasks tab and Send to chat, per-chat Claude
accounts, `/rc`), and its built-in updater is off: it never replaces itself with an official
release. New builds come only from this fork's
[Releases page](https://github.com/ferbiy/orca-overhedge/releases).

Both formats are x86_64 (amd64) only:

| File                                                           | For                                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orca-ide_<version>+overhedge.<n>.g<commit>_amd64.deb`         | **Recommended** on Ubuntu, Debian, Mint, Pop!\_OS. App menu entry, icon, the `orca-ide` CLI, and a working Chromium sandbox. It is the same package the server uses. |
| `Orca-<version>_overhedge.<k>.g<commit>-linux-x86_64.AppImage` | Any other distro (Fedora, Arch, ...). One file, nothing to install.                                                                                                  |

The `.deb` package is called `orca-ide`, like the official one, so it installs over the official
package as a normal upgrade, and both use the same data (`~/.config/orca`, `~/.orca`).

## 1. Download and verify

Take the newest release that has the Linux files:

```bash
mkdir -p ~/orca-overhedge && cd ~/orca-overhedge
TAG=v1.4.278-overhedge.30            # the newest release on the Releases page
gh release download "$TAG" -R ferbiy/orca-overhedge -p '*_amd64.deb' -p 'SHA256SUMS'
# AppImage instead: -p '*-linux-x86_64.AppImage' -p 'SHA256SUMS'
# without gh: curl -LO https://github.com/ferbiy/orca-overhedge/releases/download/$TAG/<file name>
sha256sum -c --ignore-missing SHA256SUMS
```

Do not install a file that does not print `OK`.

## 2. Before installing

1. Quit Orca completely, including the tray icon.
2. Back up your data (small, and it is what you restore if a rollback ever needs it):

   ```bash
   tar -C ~ -czf ~/orca-backup-$(date +%F).tgz .config/orca .orca 2>/dev/null; ls -lh ~/orca-backup-*.tgz
   ```

3. If you run the official AppImage, remove it or stop using it. Two different apps must never run
   on the same data at the same time.

## 3a. Install the .deb (Ubuntu 22.04+, Debian 12+)

```bash
cd ~/orca-overhedge
sudo apt install ./orca-ide_*+overhedge.*_amd64.deb
dpkg-query -W orca-ide        # orca-ide  <version>+overhedge.<n>.g<commit>
```

`apt` pulls the dependencies, including `libsecret-1-0`, `xvfb`, `xdotool` and `xclip` (the last
three serve headless use and computer use; they do no harm on a desktop).

Start it from the app menu ("Orca", desktop entry `orca-ide.desktop`) or run `/opt/Orca/orca-ide`.
The `orca-ide` command in a terminal is Orca's CLI (`orca-ide --help`), not the window.

The package installs `/opt/Orca/chrome-sandbox` setuid root (`-rwsr-xr-x`), so the Chromium sandbox
works on Ubuntu 24.04 with AppArmor's user-namespace restriction, without `--no-sandbox`. Check
with `ls -l /opt/Orca/chrome-sandbox`.

## 3b. Install the AppImage (other distros)

```bash
mkdir -p ~/Applications
install -m 755 ~/orca-overhedge/Orca-*-linux-x86_64.AppImage ~/Applications/
~/Applications/Orca-*-linux-x86_64.AppImage
```

- It needs the usual desktop libraries (GTK 3, NSS, libsecret) and FUSE 3 (`fusermount3`, package
  `fuse3`; `libfuse2` is not needed). Without FUSE run it with `APPIMAGE_EXTRACT_AND_RUN=1`.
- If Orca warns in Settings that it could not find a keyring and stores secrets without
  encryption, start it with `--password-store=gnome-libsecret` (KDE: `--password-store=kwallet6`).
  See [Keyring](#keyring-secret-storage).
- The AppImage adds no app menu entry. Use an integrator such as Gear Lever or AppImageLauncher,
  or write a `.desktop` file yourself.
- Keep one version of the file in `~/Applications`.

## Update to a newer build

Quit Orca, download the newer file (step 1), then:

```bash
sudo apt install ./orca-ide_<new version>+overhedge.*_amd64.deb     # .deb
# AppImage: put the new file in ~/Applications and delete the old one
```

"Check for updates" in Orca reports nothing. That is expected: the official update channel is off
in the fork, and updates come only from this fork's Releases page.

## Rollback

- **To an earlier fork build:**
  `sudo apt install --allow-downgrades ./orca-ide_<older version>+overhedge.*_amd64.deb`.
- **To official Orca:** download `orca-ide_<version>_amd64.deb` from
  [stablyai/orca releases](https://github.com/stablyai/orca/releases) and run
  `sudo apt install --allow-downgrades ./orca-ide_<version>_amd64.deb`. The flag is needed because
  `<version>+overhedge.<n>` sorts above `<version>`. Official Orca updates itself again and the
  fork's features go away: it does not load the ClickUp plugin (it asks for `chat:send`), and
  per-chat account pins are ignored.
- **AppImage:** run another file.
- Going back to a much older upstream version may not read data written by the newer one. Then
  restore the backup from step 2, with Orca quit: `tar -C ~ -xzf ~/orca-backup-<date>.tgz`.
- To remove the app: `sudo apt remove orca-ide`. Your data in `~/.config/orca` and `~/.orca` stays.

## Keyring (secret storage)

- Orca encrypts saved secrets (API keys, connector and plugin tokens) with Electron safeStorage. The
  key lives in your desktop's Secret Service (GNOME Keyring or KWallet) as "Chromium Safe Storage"
  with the attribute `application=orca`; Seahorse ("Passwords and Keys") shows it.
- Linux has no code signature that ties the key to one build. The fork has the same app name, so it
  reads the same key: switching official to fork and back needs no prompt.
- **No keyring, or a locked one** (a minimal window manager, auto-login without unlocking, a session
  over SSH): Orca falls back to `basic_text`, a built-in key, so secrets are only obfuscated, and
  Settings warns about it. Secrets saved earlier with a keyring cannot be read in such a session
  until the keyring is back; nothing is lost. Install and unlock `gnome-keyring` (or KWallet), or
  enter the secrets again if you must work without one.
- **A keyring exists but Orca does not see it** (tiling window managers, an unusual
  `XDG_CURRENT_DESKTOP`; common with the AppImage): start Orca with
  `--password-store=gnome-libsecret` (KDE: `--password-store=kwallet6`), for example
  `~/Applications/Orca-*-linux-x86_64.AppImage --password-store=gnome-libsecret`, and put the same
  flag in your `.desktop` file's `Exec=` line.
- The ClickUp plugin keeps its token through Orca, so it needs a working keyring.
- Claude Code's own credentials are kept by the `claude` CLI in its own files; Orca does not
  encrypt them.

## Connect to an Orca server

A team server runs Orca headless (`orca-ide serve`, see [server.md](server.md)); the desktop app
connects to it as a remote server.

1. You need network access to the server, over your VPN or an SSH tunnel (see
   [server.md](server.md#6-pair-a-desktop)).
2. The server's admin creates an access link for you on the server (`orca-ide pair --address
   <address>`) and sends it privately. The link is a secret: never paste it into a chat, task or
   note.
3. In Orca: **Settings › Remote Orca Servers › Add Server**, paste the link and confirm.
4. The server shows up in the host list with its workspaces, chats and terminals.

Access can be revoked on the server. If a link is lost or leaked, ask for a new one.

## Troubleshooting

**The window does not open from the AppImage; FUSE errors.** Install `fuse3`, or run with
`APPIMAGE_EXTRACT_AND_RUN=1`.

**"The SUID sandbox helper binary was found, but is not configured correctly"** (deb). The
package's post-install step did not run or was undone: run
`sudo chown root:root /opt/Orca/chrome-sandbox && sudo chmod 4755 /opt/Orca/chrome-sandbox`.
Do not start Orca with `--no-sandbox` as a fix.

**The AppImage runs without the sandbox on Ubuntu 24.04.** AppArmor blocks unprivileged user
namespaces there, so the AppImage starts Orca with `--no-sandbox` by itself. Use the `.deb` on
Debian and Ubuntu.

**Settings says secrets are stored without encryption.** See [Keyring](#keyring-secret-storage):
start with `--password-store=gnome-libsecret` (or `kwallet6`), or unlock the keyring.

**`apt` says the version is lower / refuses to downgrade.** Add `--allow-downgrades` when you go
back to an older or official build on purpose.

**Orca offers an official update.** A fork build never does. Check `dpkg-query -W orca-ide` (or
About): without `+overhedge` you are running the official app; install the fork again.
