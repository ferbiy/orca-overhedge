# macOS: встановлення збірки Orca від Overhedge

[English](macos.md) · [Усі інструкції](README.uk.md)

Застосунок форку для macOS — той самий десктопний Orca, що й офіційний, зібраний з цього форку.
Чати, налаштування й плагіни лишаються, бо app id і теки даних ті самі
(`~/Library/Application Support/orca` і `~/.orca`).

Що треба знати наперед:

- **Лише Apple silicon** (arm64). Збірки для Intel немає.
- **Ad-hoc підпис, без нотаризації.** У форку немає Apple Developer ID, тому macOS вважає
  застосунок програмою від невідомого розробника. Прапорець карантину знімаєте один раз на кожне
  встановлення (крок 4).
- **Оновлення вимкнені.** Застосунок ніколи не оновлюється сам, і тим паче не до офіційного
  релізу. Нові збірки є лише на сторінці [Releases](https://github.com/ferbiy/orca-overhedge/releases)
  форку; кожну встановлюєте вручну, як нижче.
- **Запит keychain.** При першому запуску macOS просить доступ до запису «Orca Safe Storage».
  Натисніть **Always Allow**. Кожна нова збірка спитає ще раз, бо ad-hoc підпис щоразу інший.

## 1. Завантаження

На сторінці [Releases](https://github.com/ferbiy/orca-overhedge/releases) знайдіть найновіший реліз,
у якому є `*-mac-arm64.zip` (реліз, що змінив лише сервер чи Linux, може його не мати).
Завантажте zip і `SHA256SUMS` у браузері або через GitHub CLI:

```bash
mkdir -p ~/Downloads/orca-overhedge && cd ~/Downloads/orca-overhedge
TAG=v1.4.278-overhedge.28          # обраний реліз
gh release download "$TAG" -R ferbiy/orca-overhedge -p '*-mac-arm64.zip' -p 'SHA256SUMS'
# без gh: curl -LO https://github.com/ferbiy/orca-overhedge/releases/download/$TAG/<ім'я файлу>
```

## 2. Перевірка контрольної суми

```bash
cd ~/Downloads/orca-overhedge
shasum -a 256 -c SHA256SUMS --ignore-missing
# Orca-<версія>_overhedge.<m>.g<коміт>-mac-arm64.zip: OK
```

Файл, для якого не надруковано `OK`, не встановлюйте.

## 3. Закрийте Orca і збережіть поточний застосунок

1. Закрийте Orca повністю: **Orca › Quit Orca** (Cmd-Q), а не лише вікно. Перевірте, що процесу
   немає:

   ```bash
   pgrep -x Orca || echo "Orca не запущена"
   ```

2. Збережіть поточний застосунок, щоб можна було до нього повернутися:

   ```bash
   mv /Applications/Orca.app "/Applications/Orca-previous.app"
   ```

   Якщо переходите з офіційного, зручно назвати його, наприклад, `Orca-official-1.4.278.app`.

3. Необов'язково, але бажано перед переходом між версіями апстриму: резервна копія даних (може
   займати кілька ГБ):

   ```bash
   tar -C ~ -czf ~/orca-backup-$(date +%F).tgz "Library/Application Support/orca" .orca
   ```

## 4. Встановлення

```bash
cd ~/Downloads/orca-overhedge
rm -rf unzipped && ditto -x -k Orca-*-mac-arm64.zip unzipped
xattr -dr com.apple.quarantine unzipped/Orca.app   # інакше Gatekeeper не відкриє непідписаний застосунок
mv unzipped/Orca.app /Applications/Orca.app
open /Applications/Orca.app
```

Якщо в теці кілька zip, замість `Orca-*-mac-arm64.zip` вкажіть повне ім'я файлу.

## 5. Перший запуск

- **Keychain:** macOS просить пароль входу, щоб Orca могла користуватися «Orca Safe Storage».
  Введіть його і натисніть **Always Allow**. Якщо натиснути Deny, зашифровані Orca секрети
  (збережені API-ключі, токени конекторів і плагінів) у цьому запуску не читаються; нічого не
  видаляється. Закрийте, запустіть знову і дозвольте. Логін самого Claude Code це не зачіпає.
- **Дозволи macOS** (Files and Folders, Accessibility, Screen Recording для computer use,
  сповіщення) прив'язані до підпису застосунку, тож їх, можливо, доведеться видати ще раз.
- Перевірте версію: Orca › About Orca (або Settings) показує `<версія>+overhedge.<n>.g<коміт>`.

## Оновлення на новішу збірку

Повторіть кроки 1–5 з новішим zip. Тримайте попередню збірку (наприклад, як
`Orca-previous.app`), доки нова не запрацює, потім видаліть стару копію. Запит keychain буде знову.

«Check for updates» у застосунку нічого не знаходить. Так і має бути: офіційний канал оновлень у
форку вимкнений, оновлення є лише на сторінці Releases форку.

## Відкат

**На попередню збірку** (форку чи офіційну), коли Orca закрита:

```bash
rm -rf /Applications/Orca.app
mv "/Applications/Orca-previous.app" /Applications/Orca.app
open /Applications/Orca.app
```

**На офіційну Orca:** закрийте Orca і встановіть офіційний застосунок зі
[stablyai/orca releases](https://github.com/stablyai/orca/releases) (`orca-macos-arm64.dmg`) або з
[orca.dev](https://orca.dev). Він відкриє ті самі дані. Далі він оновлюватиметься з офіційного
каналу, а функції форку зникнуть: закріплення акаунтів за чатами ігноруються, `/rc` і команди
форку зникають, вкладка Tasks і Send to chat плагіна ClickUp перестають працювати (офіційна Orca
не завантажує плагін, що просить `chat:send`).

Повернення на значно старішу версію апстриму може не показати все, що записала новіша. Тоді
відновіть резервну копію з кроку 3, коли Orca закрита: `tar -C ~ -xzf ~/orca-backup-<дата>.tgz`.

## Якщо щось не так

**«Orca is damaged and can't be opened. You should move it to the Trash.»** Прапорець карантину
досі стоїть (застосунок розпакував Finder чи Safari або його скопіювали знову). Виконайте:

```bash
xattr -dr com.apple.quarantine /Applications/Orca.app
```

**«Orca cannot be opened because the developer cannot be verified»** або **«Apple could not verify
Orca is free of malware».** Зніміть прапорець карантину, як вище. Якщо macOS однаково блокує,
відкрийте System Settings › Privacy & Security, знайдіть повідомлення про Orca і натисніть
**Open Anyway**, або в Finder клацніть застосунок із Control і виберіть **Open**.

**Застосунок одразу закривається або «не підтримується на цьому Mac».** Збірка лише для arm64; на
Mac з Intel вона не працює.

**Keychain питає знову і знову.** Натисніть **Always Allow**, а не Allow. Один запит на кожну нову
збірку — це нормально.

**Зникли збережені ключі або входи в плагіни.** Мабуть, у запиті keychain було натиснуто Deny.
Закрийте Orca, запустіть знову і натисніть Always Allow; нічого не втрачено.

**Orca пропонує офіційне оновлення або замінила себе.** Зі збіркою форку так не буває; перевірте
версію в About. Якщо там немає `+overhedge`, у вас офіційний застосунок: встановіть форк знову зі
сторінки Releases форку.
