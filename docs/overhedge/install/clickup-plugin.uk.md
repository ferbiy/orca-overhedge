# Плагін ClickUp Tasks: встановлення

[English](clickup-plugin.md) · [Усі інструкції](README.uk.md)

[ClickUp Tasks](https://github.com/ferbiy/orca-clickup-tasks) приносить ваші задачі ClickUp в Orca:
бічна панель, а у форку ще вкладка ClickUp на сторінці Tasks (список або дошка), Start у окремому
worktree і Send to chat. Його README описує всі функції, дозволи й налаштування OAuth-застосунку
ClickUp; ця сторінка — шлях встановлення.

## Перед початком

- **Десктопний застосунок форку**, macOS або Linux ([macOS](macos.uk.md),
  [Linux](linux-desktop.uk.md)). Вкладка на сторінці Tasks і Send to chat є лише у форку, а
  поточні версії плагіна просять доступ `chat:send`, який знає лише форк, тому офіційна Orca їх не
  встановить.
- **Плагіни працюють у десктопному застосунку**, а не на сервері. Якщо десктоп підключений до
  сервера Orca, плагін однаково працює на вашому комп'ютері й може запускати задачі в проєктах
  сервера.
- **Робоче сховище секретів ОС**: macOS Keychain, на Linux — GNOME Keyring або KWallet (див.
  [keyring на Linux](linux-desktop.uk.md#keyring-сховище-секретів)). Плагін тримає там токен
  ClickUp через Orca.

## 1. Встановлення закріпленої версії

Встановлюйте тег релізу або повний SHA коміту репозиторію плагіна, ніколи не запис зі спільного
каталогу і ніколи не гілку. Беріть версію, яку назве команда, або найновіший реліз на сторінці
[Releases](https://github.com/ferbiy/orca-clickup-tasks/releases) плагіна (наприклад, `v0.5.0`).
Orca має бути запущена.

CLI на macOS називається `orca`, а з Linux-пакета `.deb` — `orca-ide`; команди однакові.

```bash
orca plugin install ferbiy/orca-clickup-tasks@<tag-or-sha> --json
```

Без `--approve` нічого не встановлюється. Команда виходить з кодом 3 (`approval_required`) і
друкує, до чого плагін отримає доступ (capabilities: workspace, сповіщення, секрети, `chat:send`
тощо), видавця й репозиторій, а також точну команду з `--approve <fingerprint>`. Перегляньте
список; якщо він збігається з README плагіна, підтвердьте:

```bash
orca plugin install ferbiy/orca-clickup-tasks@<tag-or-sha> --approve <fingerprint> --json
```

Плагін встановлюється як `ferbiy.clickup-tasks`. Якщо стоїть апстримний `gthjnk.clickup-tasks`,
спершу видаліть його, щоб панель ClickUp була одна:

```bash
orca plugin uninstall gthjnk.clickup-tasks
```

## 2. Вимкніть автооновлення плагінів

**Settings › Plugins › вимкніть «Update plugins automatically»** (те саме є в меню «Plugin
settings» на сторінці Plugins). Закріплений плагін і так не оновлюється сам (`orca plugin update`
показує його як `pinned`); вимкнений перемикач гарантує, що й жоден плагін із каталогу не
зміниться без вас.

## 3. Вхід

Відкрийте панель **ClickUp Tasks** і увійдіть: через OAuth зі своїм OAuth-застосунком ClickUp
(налаштовується один раз, див.
[Connect](https://github.com/ferbiy/orca-clickup-tasks/tree/overhedge#connect-create-your-clickup-oauth-app-once)
у README плагіна) або з персональним API-токеном (ClickUp › Settings › Apps › API Token). Потім у
**Settings › Lists** виберіть, які Spaces, Folders чи Lists бачить Orca. Доки не виберете, нічого
не завантажується.

## Оновлення плагіна

Встановіть новіший тег чи коміт тими самими двома командами (крок 1). Крок підтвердження знову
покаже список доступів; перевірте, чи не з'явилися нові.

## Якщо щось не так

**Встановлення відхилено через `chat:send`.** У вас офіційна Orca. Спершу встановіть десктопний
застосунок форку.

**На сторінці Tasks немає вкладки ClickUp.** Перевірте, що застосунок — форк (About показує
`+overhedge`), плагін увімкнений і ви увійшли.

**Плагін постійно просить увійти або не може зберегти токен.** Сховище секретів недоступне: на
macOS натисніть Always Allow у запиті «Orca Safe Storage»; на Linux розблокуйте keyring або
запускайте Orca з `--password-store=gnome-libsecret` (див.
[keyring на Linux](linux-desktop.uk.md#keyring-сховище-секретів)).
