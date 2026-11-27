# Linux-десктоп: встановлення збірки Orca від Overhedge

[English](linux-desktop.md) · [Усі інструкції](README.uk.md)

Десктопний застосунок форку для Linux — той самий Orca (Electron), що й офіційний, зібраний з цього
форку. У ньому є функції форку (вкладка Tasks і Send to chat плагіна ClickUp, акаунти Claude для
окремих чатів, `/rc`), а вбудований оновлювач вимкнений: застосунок ніколи не замінить себе
офіційним релізом. Нові збірки є лише на сторінці
[Releases](https://github.com/ferbiy/orca-overhedge/releases) форку.

Обидва формати лише для x86_64 (amd64):

| Файл                                                         | Для кого                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orca-ide_<версія>+overhedge.<n>.g<коміт>_amd64.deb`         | **Рекомендовано** для Ubuntu, Debian, Mint, Pop!\_OS. Пункт у меню застосунків, іконка, CLI `orca-ide` і робоча пісочниця Chromium. Це той самий пакет, що й на сервері. |
| `Orca-<версія>_overhedge.<k>.g<коміт>-linux-x86_64.AppImage` | Будь-який інший дистрибутив (Fedora, Arch, ...). Один файл, нічого не треба встановлювати.                                                                               |

Пакет `.deb` називається `orca-ide`, так само як офіційний, тому встановлюється поверх офіційного як
звичайне оновлення, і обидва користуються тими самими даними (`~/.config/orca`, `~/.orca`).

## 1. Завантаження і перевірка

Беріть найновіший реліз, у якому є Linux-файли:

```bash
mkdir -p ~/orca-overhedge && cd ~/orca-overhedge
TAG=v1.4.278-overhedge.30            # найновіший реліз зі сторінки Releases
gh release download "$TAG" -R ferbiy/orca-overhedge -p '*_amd64.deb' -p 'SHA256SUMS'
# для AppImage: -p '*-linux-x86_64.AppImage' -p 'SHA256SUMS'
# без gh: curl -LO https://github.com/ferbiy/orca-overhedge/releases/download/$TAG/<ім'я файлу>
sha256sum -c --ignore-missing SHA256SUMS
```

Файл, для якого не надруковано `OK`, не встановлюйте.

## 2. Перед встановленням

1. Закрийте Orca повністю, разом із треєм.
2. Зробіть резервну копію даних (вона невелика, і саме її відновлюють, якщо відкат цього
   потребує):

   ```bash
   tar -C ~ -czf ~/orca-backup-$(date +%F).tgz .config/orca .orca 2>/dev/null; ls -lh ~/orca-backup-*.tgz
   ```

3. Якщо зараз у вас офіційний AppImage, видаліть його або не запускайте. Два різні застосунки на
   одних даних одночасно запускати не можна.

## 3a. Встановлення .deb (Ubuntu 22.04+, Debian 12+)

```bash
cd ~/orca-overhedge
sudo apt install ./orca-ide_*+overhedge.*_amd64.deb
dpkg-query -W orca-ide        # orca-ide  <версія>+overhedge.<n>.g<коміт>
```

`apt` сам доставить залежності, зокрема `libsecret-1-0`, `xvfb`, `xdotool` і `xclip` (останні три
потрібні для headless-режиму й computer use; десктопу вони не заважають).

Запуск: «Orca» в меню застосунків (ярлик `orca-ide.desktop`) або `/opt/Orca/orca-ide`. Команда
`orca-ide` у терміналі — це CLI Orca (`orca-ide --help`), а не вікно.

Пакет ставить `/opt/Orca/chrome-sandbox` із setuid root (`-rwsr-xr-x`), тому пісочниця Chromium
працює на Ubuntu 24.04 з обмеженням user namespaces від AppArmor без `--no-sandbox`. Перевірити:
`ls -l /opt/Orca/chrome-sandbox`.

## 3b. Встановлення AppImage (інші дистрибутиви)

```bash
mkdir -p ~/Applications
install -m 755 ~/orca-overhedge/Orca-*-linux-x86_64.AppImage ~/Applications/
~/Applications/Orca-*-linux-x86_64.AppImage
```

- Потрібні звичайні бібліотеки десктопа (GTK 3, NSS, libsecret) і FUSE 3 (`fusermount3`, пакет
  `fuse3`; `libfuse2` не потрібен). Без FUSE запускайте з `APPIMAGE_EXTRACT_AND_RUN=1`.
- Якщо Orca в Settings попереджає, що не знайшла keyring і зберігає секрети без шифрування,
  запускайте з `--password-store=gnome-libsecret` (KDE: `--password-store=kwallet6`). Див.
  [Keyring](#keyring-сховище-секретів).
- Пункту в меню AppImage сам не створює. Скористайтеся інтегратором (наприклад, Gear Lever або
  AppImageLauncher) або створіть `.desktop` вручну.
- Тримайте у `~/Applications` лише одну версію файлу.

## Оновлення на новішу збірку

Закрийте Orca, завантажте новіший файл (крок 1), потім:

```bash
sudo apt install ./orca-ide_<нова версія>+overhedge.*_amd64.deb     # .deb
# AppImage: покладіть новий файл у ~/Applications, старий видаліть
```

«Check for updates» в Orca нічого не знаходить. Так і має бути: офіційний канал оновлень у форку
вимкнений, оновлення є лише на сторінці Releases форку.

## Відкат

- **На попередню збірку форку:**
  `sudo apt install --allow-downgrades ./orca-ide_<старіша версія>+overhedge.*_amd64.deb`.
- **На офіційну Orca:** завантажте `orca-ide_<версія>_amd64.deb` зі
  [stablyai/orca releases](https://github.com/stablyai/orca/releases) і виконайте
  `sudo apt install --allow-downgrades ./orca-ide_<версія>_amd64.deb`. Прапорець потрібен, бо
  `<версія>+overhedge.<n>` сортується вище за `<версія>`. Офіційна Orca знову оновлюватиметься
  сама, а функції форку зникнуть: плагін ClickUp вона не завантажить (він просить `chat:send`), а
  закріплення акаунтів за чатами ігноруються.
- **AppImage:** просто запускайте інший файл.
- Повернення на значно старішу версію апстриму може не прочитати дані, записані новішою. Тоді
  відновіть резервну копію з кроку 2, коли Orca закрита: `tar -C ~ -xzf ~/orca-backup-<дата>.tgz`.
- Видалити застосунок: `sudo apt remove orca-ide`. Дані в `~/.config/orca` і `~/.orca` лишаються.

## Keyring (сховище секретів)

- Orca шифрує збережені секрети (API-ключі, токени конекторів і плагінів) через Electron
  safeStorage. Ключ лежить у Secret Service вашого десктопа (GNOME Keyring або KWallet) під назвою
  «Chromium Safe Storage» з атрибутом `application=orca`; його видно в Seahorse («Passwords and
  Keys»).
- На Linux немає підпису коду, який прив'язував би ключ до конкретної збірки. Форк має ту саму назву
  застосунку, тому бачить той самий ключ: перехід з офіційної на форк і назад обходиться без
  запитів.
- **Keyring немає або він заблокований** (мінімальний віконний менеджер, автовхід без
  розблокування, сесія через SSH): Orca переходить на `basic_text`, вбудований ключ, тобто секрети
  лише обфусковані, і Settings про це попереджає. Секрети, збережені раніше з keyring, у такій
  сесії не читаються, доки keyring знову не стане доступним; нічого не втрачається. Встановіть і
  розблокуйте `gnome-keyring` (або KWallet) або введіть секрети знову, якщо мусите працювати без
  нього.
- **Keyring є, але Orca його не бачить** (тайлінгові віконні менеджери, нестандартний
  `XDG_CURRENT_DESKTOP`; часто з AppImage): запускайте Orca з `--password-store=gnome-libsecret`
  (KDE: `--password-store=kwallet6`), наприклад
  `~/Applications/Orca-*-linux-x86_64.AppImage --password-store=gnome-libsecret`, і додайте той
  самий прапорець у рядок `Exec=` вашого `.desktop`.
- Плагін ClickUp зберігає токен через Orca, тому йому потрібен робочий keyring.
- Облікові дані самого Claude Code зберігає CLI `claude` у власних файлах; Orca їх не шифрує.

## Підключення до сервера Orca

Командний сервер — це Orca в headless-режимі (`orca-ide serve`, див. [server.uk.md](server.uk.md));
десктопний застосунок підключається до нього як до віддаленого сервера.

1. Потрібен мережевий доступ до сервера: через ваш VPN або SSH-тунель (див.
   [server.uk.md](server.uk.md#6-підключення-десктопа)).
2. Адміністратор сервера створює для вас посилання доступу на сервері (`orca-ide pair --address
   <адреса>`) і передає його приватно. Посилання — це секрет: не вставляйте його в чати, задачі чи
   нотатки.
3. В Orca: **Settings › Remote Orca Servers › Add Server**, вставте посилання і підтвердьте.
4. Сервер з'явиться в списку хостів разом із воркспейсами, чатами й терміналами.

Доступ можна відкликати на сервері. Якщо посилання загубилося або витекло, попросіть нове.

## Якщо щось не так

**AppImage не відкриває вікно; помилки FUSE.** Встановіть `fuse3` або запускайте з
`APPIMAGE_EXTRACT_AND_RUN=1`.

**«The SUID sandbox helper binary was found, but is not configured correctly»** (deb). Крок
пакета після встановлення не виконався або його скасували: виконайте
`sudo chown root:root /opt/Orca/chrome-sandbox && sudo chmod 4755 /opt/Orca/chrome-sandbox`.
Не лікуйте це запуском із `--no-sandbox`.

**AppImage на Ubuntu 24.04 працює без пісочниці.** AppArmor там блокує непривілейовані user
namespaces, тож AppImage сам запускає Orca з `--no-sandbox`. На Debian і Ubuntu ставте `.deb`.

**Settings пише, що секрети зберігаються без шифрування.** Див. [Keyring](#keyring-сховище-секретів):
запускайте з `--password-store=gnome-libsecret` (або `kwallet6`) чи розблокуйте keyring.

**`apt` каже, що версія нижча, або відмовляється її понижувати.** Додайте `--allow-downgrades`,
коли свідомо повертаєтеся на старішу чи офіційну збірку.

**Orca пропонує офіційне оновлення.** Збірка форку так ніколи не робить. Перевірте
`dpkg-query -W orca-ide` (або About): якщо немає `+overhedge`, у вас офіційний застосунок;
встановіть форк знову.
