# Сервер Orca: встановлення збірки Overhedge на новий хост

[English](server.md) · [Усі інструкції](README.uk.md)

Тут описано, як підняти headless-сервер Orca (`orca-ide serve`) з патчем форку на чистому хості
Ubuntu 24.04 x86_64. Десктопні застосунки й телефони потім підключаються до нього через VPN або
SSH-тунель. Функції форку для чатів і акаунтів (акаунт Claude для окремого чату, `/orca-migrate`,
`/rc`, переписка Claude-сесій різних акаунтів) працюють на сервері, тож для них досить
офіційного десктопного чи мобільного застосунку; плагіну ClickUp потрібен десктопний застосунок
форку ([macOS](macos.uk.md), [Linux](linux-desktop.uk.md)).

Позначки нижче: `<user>` — обліковий запис, під яким працює Orca; `<host>` — як ви заходите на
сервер через SSH; `<vpn-address>` — адреса сервера у вашому VPN (для Tailscale: `tailscale ip -4`);
`<vpn-interface>` — мережевий інтерфейс VPN (наприклад, `tailscale0` або `wg0`).

## 1. Передумови

- Ubuntu 24.04 (або 22.04) x86_64 з sudo.
- Звичайний користувач для Orca (`<user>`); не запускайте Orca від root.
- Приватна мережа між сервером і клієнтами: VPN (Tailscale, WireGuard) або SSH-доступ для тунелю.
  Ніколи не відкривайте порт Orca в інтернет.
- CLI агентів для `<user>`: Claude Code (`claude`, зазвичай у `~/.local/bin`), за потреби Codex
  та інші.

## 2. Завантаження і перевірка пакета

На сервері візьміть найновіший `.deb` зі сторінки
[Releases](https://github.com/ferbiy/orca-overhedge/releases) форку:

```bash
mkdir -p ~/orca-debs && cd ~/orca-debs
TAG=v1.4.278-overhedge.30            # найновіший реліз зі сторінки Releases
gh release download "$TAG" -R ferbiy/orca-overhedge -p '*_amd64.deb' -p 'SHA256SUMS'
# без gh: curl -LO https://github.com/ferbiy/orca-overhedge/releases/download/$TAG/<ім'я файлу>
sha256sum -c --ignore-missing SHA256SUMS
```

Для відкату тримайте поруч і офіційний пакет тієї самої версії апстриму:

```bash
VER=1.4.278                           # версія апстриму з тегу
gh release download "v$VER" -R stablyai/orca -p "orca-ide_${VER}_amd64.deb"
```

## 3. Встановлення і фіксація пакета

```bash
cd ~/orca-debs
sudo apt-get install -y ./orca-ide_*+overhedge.*_amd64.deb
dpkg-query -W orca-ide            # orca-ide  <версія>+overhedge.<n>.g<коміт>
sudo apt-mark hold orca-ide       # щоб apt не замінив його офіційним пакетом
orca-ide account migrate --help   # у форку друкує довідку; офіційна Orca каже "Unknown command"
```

Пакет ставиться в `/opt/Orca` і `/usr/bin/orca-ide`, ті самі шляхи, що й в офіційного.

## 4. Фаєрвол: порт Orca лише з loopback і VPN

`orca-ide serve` слухає порт 6768. Після першого мережевого підключення він слухає на всіх
інтерфейсах, тому обмежте порт loopback і інтерфейсом VPN. Цей невеликий сервіс додає правила
iptables при завантаженні, до старту Orca (замініть `<vpn-interface>`):

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

Якщо до сервера заходять лише через SSH-тунель, рядок із VPN приберіть: досить loopback. Якщо
фаєрвол уже керується через `ufw` чи nftables, додайте рівноцінне правило там.

## 5. Сервіс `orca-serve`

Замініть `<user>` і `<vpn-address>` (`127.0.0.1`, якщо клієнти заходять лише через SSH-тунель).
Додайте в `PATH` усі теки, де лежать `claude`, `codex` та інші інструменти ваших агентів.

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
sudo loginctl enable-linger <user>     # радить сама Orca: термінали надійніше переживають рестарти
sudo systemctl daemon-reload
sudo systemctl enable --now orca-port-guard orca-serve
systemctl is-active orca-serve
journalctl -u orca-serve -n 30 --no-pager | grep -v -i -E 'token|pair'
```

Для Tailscale додайте `tailscaled.service` в `After=`, щоб адреса VPN уже існувала, коли Orca
стартує. У журналі можуть бути дані для підключення; нікуди їх не вставляйте.

`KillMode=process` важливий: зі стандартним (`control-group`) кожен рестарт чи оновлення вбивали б
усі термінали й агентів у них. З ним термінали й агенти працюють далі, поки сервіс перезапускається.

## 6. Підключення десктопа

Клієнти дістаються сервера одним із двох способів.

**Через VPN.** Сервіс оголошує `<vpn-address>`. На сервері від імені `<user>` створіть посилання
доступу:

```bash
orca-ide pair --address <vpn-address>
```

**Через SSH-тунель** (без VPN). На десктопі тримайте тунель відкритим, поки працюєте з сервером:

```bash
ssh -N -L 6768:127.0.0.1:6768 <host>
```

а посилання на сервері створіть для локального кінця тунелю:

```bash
orca-ide pair --address 127.0.0.1
```

Порт 6768 на десктопі має бути вільним для тунелю. Якщо тунель обірвався, Orca перепідключиться,
щойно він повернеться.

Далі в десктопному застосунку: **Settings › Remote Orca Servers › Add Server**, вставте посилання
і підтвердьте. Для телефона: `orca-ide pair --mobile --address <vpn-address>` і відскануйте
QR-код в Orca Mobile (телефон має бути у VPN).

Посилання доступу — це секрет: передавайте його приватно і ніколи не вставляйте в чати, задачі чи
нотатки. Невикористане посилання діє, доки `orca-ide pair --rotate` не замінить його. Підключені
клієнти можна відкликати на сервері; клієнту, чиє посилання витекло, дайте нове.

## 7. Акаунти Claude

Акаунти свої на кожному сервері. На сервері від імені `<user>` додайте по одному керованому
акаунту на кожну підписку Claude і увійдіть у браузері, коли попросить:

```bash
orca-ide account add --agent claude
orca-ide account list --agent claude
```

**Не копіюйте `~/.config/orca` (чи `~/.orca`) з іншого хоста.** Там токени, ключі, підключені
пристрої й логіни акаунтів того хоста; копія клонувала б ідентичності й секрети. Кожен сервер
налаштовуйте з нуля і підключайте клієнтів заново.

## 8. Перевірка встановлення

- `dpkg-query -W orca-ide` показує `+overhedge`; `orca-ide account migrate --help` друкує довідку.
- `systemctl is-active orca-serve` дає `active`, а `systemctl show -p NRestarts orca-serve` за
  хвилину лишається `0`.
- У Claude-чаті на сервері: `/orca-account` і `/rc status` відповідають рядком від Orca, а не від
  Claude, а в слеш-меню є `/orca-account`, `/orca-migrate` і `/rc`.
- З двома акаунтами: `orca-ide account migrate --all-on <акаунт> --to <інший> --dry-run` друкує
  план і нічого не змінює.

## Оновлення на новішу збірку

Оновлення є лише на сторінці Releases форку; серверний пакет Orca сама ніколи не оновлює, а
`apt-mark hold` не дає зробити це apt. Оберіть спокійний момент: термінали працюватимуть далі, але
хід Claude-чату, що стрімиться під час рестарту, може обірватися.

```bash
cd ~/orca-debs                       # спершу завантажте й перевірте новий .deb (крок 2)
sudo systemctl stop orca-serve
tar -C ~/.config -czf ~/orca-debs/orca-config-$(date +%Y%m%d-%H%M%S).tgz \
  --exclude='orca/orcad-artifacts' --exclude='orca/Cache' --exclude='orca/Code Cache' \
  --exclude='*.sock' orca
tar -C ~ -czf ~/orca-debs/dot-orca-$(date +%Y%m%d-%H%M%S).tgz .orca
chmod 600 ~/orca-debs/*.tgz           # у резервній копії є секрети
sudo apt-mark unhold orca-ide
sudo apt-get install -y ./orca-ide_<нова версія>+overhedge.<n>.g<коміт>_amd64.deb
sudo apt-mark hold orca-ide
sudo systemctl start orca-serve
dpkg-query -W orca-ide; systemctl is-active orca-serve
```

Підключені клієнти перепідключаються самі; заново підключати їх не треба.

## Відкат

Зупиніть сервіс, встановіть старіший пакет, запустіть знову:

```bash
sudo systemctl stop orca-serve
sudo apt-mark unhold orca-ide
sudo apt-get install -y --allow-downgrades ./<старіший або офіційний>.deb
sudo apt-mark hold orca-ide           # пропустіть, якщо повертаєтеся на офіційну Orca назовсім
sudo systemctl start orca-serve
```

- **Попередня збірка форку** або **офіційний пакет тієї самої версії апстриму** (з кроку 2)
  читають ті самі дані; нічого відновлювати не треба. На офіційній Orca функції форку зникають:
  закріплення акаунтів ігноруються, `/rc` і команди форку зникають.
- `--allow-downgrades` потрібен, бо `<версія>+overhedge.<n>` сортується вище за `<версія>`.
- **Старіша версія апстриму** зазвичай працює (зміни схем адитивні), але термінали, запущені під
  новішим протоколом демона терміналів, не підхоплюються і їхні сесії губляться, а чати, створені
  на новішій версії, можуть не показуватися. Резервну копію відновлюйте лише при пошкодженні даних:
  `sudo systemctl stop orca-serve; tar -C ~/.config -xzf <копія orca-config>; sudo systemctl start orca-serve`.

## Якщо щось не так

**Сервіс перезапускається по колу.** Причину покаже `journalctl -u orca-serve -n 100 --no-pager`.
Код виходу 3 означає, що цей профіль `<user>` уже обслуговує інша Orca (наприклад, запущена вручну
в терміналі); зупиніть її.

**Клієнти не підключаються.** Перевірте, що фаєрвол пропускає інтерфейс VPN
(`sudo iptables -L ORCA_SERVE -n -v`), що посилання містить адресу, досяжну для клієнта, а для
тунелю — що `ssh -L` досі працює.

**Агенти падають із «command not found».** У `PATH` сервісу немає теки з `claude` (чи `codex`).
Виправте `Environment=PATH=...`, потім `sudo systemctl daemon-reload` і
`sudo systemctl restart orca-serve`.

**Термінали вмирають при кожному рестарті.** У юніті немає `KillMode=process`.
`systemctl show -p KillMode orca-serve` має друкувати `KillMode=process`.

**`apt upgrade` хоче замінити orca-ide.** Пакет не зафіксовано: `sudo apt-mark hold orca-ide`.
