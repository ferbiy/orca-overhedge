# Orca server: install the Overhedge build on a new host

[Українською](server.uk.md) · [All install guides](README.md)

This sets up a headless Orca server (`orca-ide serve`) with the fork's patch on a fresh
Ubuntu 24.04 x86_64 host. Desktop apps and phones then connect to it over a VPN or an SSH tunnel.
The chat and account features of the fork (per-chat Claude accounts, `/orca-migrate`, `/rc`, Claude
peers across accounts) run on the server, so an official desktop or mobile app is enough to use
them; the ClickUp plugin needs the fork's desktop app
([macOS](macos.md), [Linux](linux-desktop.md)).

Placeholders used below: `<user>` is the account Orca runs as, `<host>` is how you reach the server
over SSH, `<vpn-address>` is the server's address on your VPN (for Tailscale: `tailscale ip -4`),
`<vpn-interface>` is the VPN's network interface (for example `tailscale0` or `wg0`).

## 1. Prerequisites

- Ubuntu 24.04 (or 22.04) x86_64 with sudo.
- A normal user account for Orca (`<user>`); do not run Orca as root.
- A private network between the server and its clients: a VPN such as Tailscale or WireGuard, or
  SSH access for a tunnel. Never expose the Orca port to the internet.
- The agent CLIs for `<user>`: Claude Code (`claude`, usually in `~/.local/bin`), and Codex or
  others if you use them.

## 2. Download and verify the package

On the server, take the newest `.deb` from this fork's
[Releases page](https://github.com/ferbiy/orca-overhedge/releases):

```bash
mkdir -p ~/orca-debs && cd ~/orca-debs
TAG=v1.4.278-overhedge.30            # the newest release on the Releases page
gh release download "$TAG" -R ferbiy/orca-overhedge -p '*_amd64.deb' -p 'SHA256SUMS'
# without gh: curl -LO https://github.com/ferbiy/orca-overhedge/releases/download/$TAG/<file name>
sha256sum -c --ignore-missing SHA256SUMS
```

Also keep the official package of the same upstream version, for a rollback:

```bash
VER=1.4.278                           # the upstream version in the tag
gh release download "v$VER" -R stablyai/orca -p "orca-ide_${VER}_amd64.deb"
```

## 3. Install and hold the package

```bash
cd ~/orca-debs
sudo apt-get install -y ./orca-ide_*+overhedge.*_amd64.deb
dpkg-query -W orca-ide            # orca-ide  <version>+overhedge.<n>.g<commit>
sudo apt-mark hold orca-ide       # keeps apt from replacing it with an official package
orca-ide account migrate --help   # prints help on the fork; official Orca says "Unknown command"
```

The package installs `/opt/Orca` and `/usr/bin/orca-ide`, the same paths as the official package.

## 4. Firewall: the Orca port only from loopback and the VPN

`orca-ide serve` listens on port 6768. After the first network pairing it listens on every
interface, so restrict the port to loopback and your VPN interface. This small service adds
iptables rules at boot, before Orca starts (replace `<vpn-interface>`):

```bash
sudo tee /usr/local/sbin/orca-port-guard.sh >/dev/null <<'EOF'
#!/bin/sh
set -e
for t in iptables ip6tables; do
  $t -N ORCA_SERVE 2>/dev/null || $t -F ORCA_SERVE
  $t -A ORCA_SERVE -i lo -j RETURN
  $t -A ORCA_SERVE -i <vpn-interface> -j RETURN
  $t -A ORCA_SERVE -j DROP
  $t -C INPUT -p tcp --dport 6768 -j ORCA_SERVE 2>/dev/null || $t -I INPUT 1 -p tcp --dport 6768 -j ORCA_SERVE
done
EOF
sudo chmod 755 /usr/local/sbin/orca-port-guard.sh
sudo tee /etc/systemd/system/orca-port-guard.service >/dev/null <<'EOF'
[Unit]
Description=Restrict the Orca serve port to loopback and the VPN
After=network-pre.target
Before=orca-serve.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/orca-port-guard.sh

[Install]
WantedBy=multi-user.target
EOF
```

If you reach the server only through an SSH tunnel, drop the VPN line: loopback alone is enough.
If you already manage the firewall with `ufw` or nftables, add the equivalent rule there instead.

## 5. The `orca-serve` service

Replace `<user>` and `<vpn-address>` (use `127.0.0.1` if clients come only through an SSH tunnel).
Add to `PATH` every folder that holds `claude`, `codex` or other tools your agents need.

```bash
sudo tee /etc/systemd/system/orca-serve.service >/dev/null <<'EOF'
[Unit]
Description=Orca runtime server
After=network-online.target orca-port-guard.service
Wants=network-online.target

[Service]
Type=simple
User=<user>
Group=<user>
WorkingDirectory=/home/<user>
Environment=HOME=/home/<user>
Environment=LIBGL_ALWAYS_SOFTWARE=1
Environment=PATH=/home/<user>/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address <vpn-address> --json
StandardOutput=journal
StandardError=journal
# Stopping serve must not kill terminals: the terminal daemon outlives a restart and Orca re-attaches it.
KillMode=process
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo loginctl enable-linger <user>     # Orca recommends it: terminals survive restarts more reliably
sudo systemctl daemon-reload
sudo systemctl enable --now orca-port-guard orca-serve
systemctl is-active orca-serve
journalctl -u orca-serve -n 30 --no-pager | grep -v -i -E 'token|pair'
```

If you use Tailscale, add `tailscaled.service` to `After=` so the VPN address exists when Orca
starts. The journal can contain pairing data; do not paste it anywhere.

`KillMode=process` matters: with the default (`control-group`) every restart or update would kill
all terminals and the agents running in them. With it, terminals and agents keep running while the
service restarts.

## 6. Pair a desktop

Clients reach the server in one of two ways.

**Over the VPN.** The service advertises `<vpn-address>`. On the server, as `<user>`, create an
access link:

```bash
orca-ide pair --address <vpn-address>
```

**Over an SSH tunnel** (no VPN). On the desktop, keep a tunnel open while you use the server:

```bash
ssh -N -L 6768:127.0.0.1:6768 <host>
```

and create the link on the server for the tunnel's local end:

```bash
orca-ide pair --address 127.0.0.1
```

The desktop's port 6768 must be free for the tunnel. If the tunnel drops, Orca reconnects once it
is back.

Then, in the desktop app: **Settings › Remote Orca Servers › Add Server**, paste the link and
confirm. For a phone use `orca-ide pair --mobile --address <vpn-address>` and scan the QR code
with Orca Mobile (the phone must be on the VPN).

An access link is a secret: send it privately and never paste it into chats, tasks or notes. An
unused link is reused until `orca-ide pair --rotate` replaces it. Paired clients can be revoked on
the server; give a client whose link leaked a new one.

## 7. Add Claude accounts

Accounts are per server. As `<user>` on the server, add one managed account per Claude
subscription and sign in in the browser when asked:

```bash
orca-ide account add --agent claude
orca-ide account list --agent claude
```

**Do not copy `~/.config/orca` (or `~/.orca`) from another host.** It holds that host's tokens,
keys, paired devices and account logins; a copy would clone identities and secrets. Set up every
server from scratch and pair clients again.

## 8. Check the installation

- `dpkg-query -W orca-ide` shows `+overhedge`; `orca-ide account migrate --help` prints help.
- `systemctl is-active orca-serve` is `active`, and
  `systemctl show -p NRestarts orca-serve` stays at `0` a minute later.
- In a Claude chat on the server: `/orca-account` and `/rc status` answer with a line from Orca, not
  from Claude, and the slash menu lists `/orca-account`, `/orca-migrate` and `/rc`.
- With two accounts: `orca-ide account migrate --all-on <account> --to <other> --dry-run` prints a
  plan and changes nothing.

## Update to a newer build

Updates come only from this fork's Releases page; Orca never updates a server package by itself,
and `apt-mark hold` stops apt from doing it. Pick a quiet moment: terminals keep running, but a
Claude chat that is streaming a turn during the restart may be cut off.

```bash
cd ~/orca-debs                       # download and verify the new .deb first (step 2)
sudo systemctl stop orca-serve
tar -C ~/.config -czf ~/orca-debs/orca-config-$(date +%Y%m%d-%H%M%S).tgz \
  --exclude='orca/orcad-artifacts' --exclude='orca/Cache' --exclude='orca/Code Cache' \
  --exclude='*.sock' orca
tar -C ~ -czf ~/orca-debs/dot-orca-$(date +%Y%m%d-%H%M%S).tgz .orca
chmod 600 ~/orca-debs/*.tgz           # the backup holds secrets
sudo apt-mark unhold orca-ide
sudo apt-get install -y ./orca-ide_<new version>+overhedge.<n>.g<commit>_amd64.deb
sudo apt-mark hold orca-ide
sudo systemctl start orca-serve
dpkg-query -W orca-ide; systemctl is-active orca-serve
```

Paired clients reconnect by themselves; there is no need to pair again.

## Rollback

Stop the service, install the older package, start it again:

```bash
sudo systemctl stop orca-serve
sudo apt-mark unhold orca-ide
sudo apt-get install -y --allow-downgrades ./<older or official>.deb
sudo apt-mark hold orca-ide           # skip this if you go back to official Orca for good
sudo systemctl start orca-serve
```

- **The previous fork build** or **the official package of the same upstream version** (kept in
  step 2) read the same data; nothing to restore. On official Orca the fork's features go away:
  account pins are ignored, and `/rc` and the fork's commands are gone.
- `--allow-downgrades` is needed because `<version>+overhedge.<n>` sorts above `<version>`.
- **An older upstream version** usually works (schema changes are additive), but terminals started
  under a newer terminal-daemon protocol are not re-attached and their sessions are lost, and
  chats created on the newer version may not show. Restore the backup only if the data is damaged:
  `sudo systemctl stop orca-serve; tar -C ~/.config -xzf <orca-config backup>; sudo systemctl start orca-serve`.

## Troubleshooting

**The service restarts in a loop.** `journalctl -u orca-serve -n 100 --no-pager` shows why. Exit
code 3 means another Orca already serves this profile for `<user>` (for example one started by hand
in a terminal); stop it.

**Clients cannot connect.** Check that the port guard lets your VPN interface through
(`sudo iptables -L ORCA_SERVE -n -v`), that the pairing link uses an address the client can reach,
and, for a tunnel, that `ssh -L` is still running.

**Agents fail with "command not found".** The service's `PATH` does not include the folder of
`claude` (or `codex`). Edit `Environment=PATH=...`, then `sudo systemctl daemon-reload` and
`sudo systemctl restart orca-serve`.

**Terminals die on every restart.** `KillMode=process` is missing from the unit.
`systemctl show -p KillMode orca-serve` must print `KillMode=process`.

**`apt upgrade` wants to replace orca-ide.** It is not held: `sudo apt-mark hold orca-ide`.
