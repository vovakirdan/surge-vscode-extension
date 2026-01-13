# Surge Syntax Highlighting for VS Code

Расширение VS Code для языка Surge (`.sg`) с подсветкой синтаксиса и LSP-функциями редактора.

## Возможности

- Подсветка синтаксиса: директивы, атрибуты, async/await, pattern matching и расширенные типы.
- LSP-диагностика, hover, переход к определению, inlay hints для `let`-типов.
- Собственная палитра TextMate только для Surge.
- Корректное оформление комментариев, строк, чисел и аннотаций (`@pure`, `@override`).

## Скриншоты

### Подсветка синтаксиса:
![Подсветка синтаксиса](images/screenshot-syntax.png)
### Диагностика (LSP):
![Диагностика](images/screenshot-diagnostics.png)

## Установка

- Откройте `Extensions` (`Ctrl+Shift+X`), найдите "Surge Syntax Highlighting" и нажмите Install.
- Или установите из терминала: `code --install-extension surge.surge-syntax-highlighting`.

## Требования

- Для LSP нужен установленный `surge` CLI (команда `surge lsp`) в `PATH`.
- Без `surge` расширение работает как подсветка синтаксиса.
- При необходимости задайте `SURGE_STDLIB` в окружении VS Code.

## Настройка

- `surge.serverPath` — путь до `surge`, используемого для `surge lsp` (по умолчанию `surge`).
- `surge.inlayHints.letTypes` — показывать inlay подсказки типов для `let`.
- `surge.inlayHints.hideObvious` — скрывать подсказки для очевидных литералов.

## Команды

- `Surge: Restart Language Server` — перезапустить LSP-сервер.

## Локальный запуск/разработка

1. `cd vscode-extension`
2. `npm install`
3. Откройте в VS Code и запустите `Run Extension` (или `code --extensionDevelopmentPath=/path/to/vscode-extension`).

## Лицензия

MIT
