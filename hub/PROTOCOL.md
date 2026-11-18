# Протокол хаба, версия 1

Хаб — одна точка на компьютере, через которую приложения экосистемы узнают друг о друге, сообщают своё состояние и просят друг друга что-то сделать. Хаб живёт внутри core.txt, который сидит в трее. Пока core.txt не запущен, хаба нет — и это нормально: каждое приложение работает само по себе и тихо пробует подключиться снова.

Образцовая реализация — [hub.js](hub.js), клиент — [client.js](client.js), проверки — [test.js](test.js). Хаб в core.txt (`src/Hub.cs`) обязан вести себя так же, как `hub.js`: те же проверки гоняются против него командой `HUB_PORT=порт node hub/test.js`.

## Адрес

`127.0.0.1:42080`, только этот компьютер. Сообщения одни и те же, способов доставки два:

| Способ | Адрес | Для кого |
|---|---|---|
| WebSocket | `ws://127.0.0.1:42080/hub` | всё, где есть WebSocket: Aura, core.txt, плагин в Steam |
| HTTP | `POST` и `GET /hub/http` | где WebSocket нет или он закрыт: основной процесс Discord |

`GET /hub` без WebSocket отвечает `{ "hub", "version", "v" }` — так можно проверить, что хаб жив.

## Кого пускают

- Запрос без заголовка `Origin` — обычная программа на этом компьютере. Пускают.
- С `Origin` пускают только страницы внутри Discord (`discord.com`, `discordapp.com` и их поддомены) и Steam (`steamloopback.host`).
- Всем остальным — `403`. Страница в браузере подключиться не может.

Хаб доверяет программам на этом компьютере так же, как им доверяют отдельные локальные порты Kapsula. Секреты через хаб не передаются.

## Сообщения

Каждое сообщение — объект JSON с полем `type`. Незнакомые типы и поля пропускаются молча: так старая программа уживается с новой.

### Знакомство

```json
→ { "type": "hello", "v": 1, "app": "aura", "name": "Aura", "version": "0.26.2", "commands": ["fx.toggle"] }
← { "type": "welcome", "v": 1, "hub": { "name": "core.txt", "version": "0.1.0" }, "client": "c1-…", "apps": [ … ] }
```

- `app` — короткое имя латиницей: `kapsula`, `aura`, `maska`, `arkada`, `core`. Правило: `^[a-z][a-z0-9-]{0,31}$`, имя `hub` занято.
- До `hello` хаб отвечает на всё `{ "type": "error", "code": "hello-first" }`.
- То же приложение подключилось второй раз — прежнее подключение закрывается, остаётся новое.
- `v` — целая версия протокола. Другая — `{ "type": "error", "code": "bad-version", "v": 1 }`.

### Состояние и события

```json
→ { "type": "state", "topic": "aura.fx", "data": { "on": true, "voice": "Студия" } }
→ { "type": "event", "topic": "arkada.achievement", "data": { "game": "…", "title": "…" } }
```

- **Состояние** хаб помнит: кто подпишется позже, сразу получит последнее. `data: null` — состояния больше нет.
- **Событие** хаб не помнит: его получают только те, кто подписан в эту секунду.
- Тема всегда начинается с имени своего приложения: `aura.fx` может прислать только `aura`. Иначе — `{ "type": "error", "code": "bad-topic" }`.
- Приложение отключилось — все его состояния рассылаются с `data: null`.

Подписчик получает то же сообщение с полем `from`:

```json
← { "type": "state", "topic": "aura.fx", "from": "aura", "data": { "on": true, "voice": "Студия" } }
```

### Подписка

```json
→ { "type": "subscribe", "topics": ["maska.voice", "aura.*", "hub.theme"] }
```

Шаблон — точное имя темы, `приложение.*` или `*`. Сразу после подписки приходят все подходящие состояния, которые хаб помнит. Свои собственные сообщения назад не приходят.

### Команды

```json
→ { "type": "command", "id": "aura-7", "to": "maska", "name": "voice.mute", "args": { "on": true } }
```

Хаб передаёт команду адресату, добавив `from`. Адресат отвечает, хаб возвращает ответ:

```json
← { "type": "result", "id": "aura-7", "from": "maska", "ok": true, "data": { "muted": true } }
```

Адресат, отвечая, указывает `"to"` — значение `from` из команды. Ошибки — `"ok": false` и `error`:

| `error` | Что случилось |
|---|---|
| `offline` | адресат не подключён |
| `unknown-command` | адресат такой команды не знает |
| `timeout` | ответа нет (ставит клиент, по умолчанию через 5 секунд) |
| другой текст | адресат попробовал и не смог |

Какие команды умеет приложение, видно в `hub.apps`.

### Что ведёт сам хаб

| Тема | Данные |
|---|---|
| `hub.apps` | кто подключён: `[{ "app", "name", "version", "commands" }]` |
| `hub.theme` | общий вид: `{ "mode": "dark" \| "light", "accent": "#RRGGBB" \| null, "reducedMotion": bool }` |

`accent: null` — у каждого приложения свой цвет из токенов. Вид меняется командой хабу:

```json
→ { "type": "command", "id": "core-1", "to": "hub", "name": "theme.set", "args": { "mode": "light", "accent": "#F08A4B" } }
```

### Настройки приложения

Все настройки экосистемы собраны на одной странице в core.txt. Приложение не рисует их само, а описывает состоянием `<приложение>.settings`; core.txt показывает их общими элементами и присылает изменения командой.

```json
→ { "type": "state", "topic": "aura.settings", "data": { "groups": [
    { "title": "Звук", "items": [
      { "key": "selfListen", "type": "switch", "label": "Слышать себя", "hint": "Обработанный голос в наушниках", "value": false },
      { "key": "quality", "type": "choice", "label": "Качество", "value": "high",
        "options": [ { "value": "low", "label": "Быстрее" }, { "value": "high", "label": "Лучше" } ] },
      { "key": "gain", "type": "slider", "label": "Усиление", "value": 6, "min": 0, "max": 24, "step": 1, "unit": "дБ" },
      { "key": "resetEq", "type": "action", "label": "Сбросить эквалайзер", "button": "Сбросить" }
    ] } ] } }
```

| `type` | Что это | Поля кроме `key`, `label`, `hint` |
|---|---|---|
| `switch` | переключатель | `value`: да или нет |
| `choice` | один вариант из нескольких | `value`, `options`: `[{ "value", "label" }]` |
| `slider` | число в пределах | `value`, `min`, `max`, `step`, `unit` |
| `action` | кнопка | `button` — надпись на ней |

Команды, которые приложение обязано понимать, если прислало настройки:

```json
← { "type": "command", "id": "core-4", "from": "core", "name": "settings.set", "args": { "key": "selfListen", "value": true } }
← { "type": "command", "id": "core-5", "from": "core", "name": "settings.run", "args": { "key": "resetEq" } }
```

- Применив настройку, приложение присылает `<приложение>.settings` заново, целиком, с новым значением. Пока оно не прислало, core.txt показывает прежнее.
- Настройку поменяли в самом приложении — оно тоже присылает состояние заново, и страница в core.txt обновляется.
- Незнакомый `type` core.txt пропускает; незнакомый `key` приложение отклоняет с `"ok": false`.
- В общую страницу стоит выносить то, что меняют часто и что понятно без окна приложения. Редкое и сложное может остаться в самом приложении.

### Что умеет сам core.txt

core.txt подключён к хабу как приложение `core`. Команда `show` показывает его окно:

```json
→ { "type": "command", "id": "kapsula-9", "to": "core", "name": "show" }
```

### Служебные

- `{ "type": "ping" }` → `{ "type": "pong" }`.
- `{ "type": "bye" }` — приложение закрывается, хаб сразу забывает его.

## Кто что сообщает

Что приложения экосистемы уже отдают в хаб. Состояние хаб помнит, событие — нет.

| Приложение | Состояния | События | Команды |
|---|---|---|---|
| `core` | — | — | `show` |
| `kapsula` | `kapsula.settings`, `kapsula.media`, `kapsula.weather`, `kapsula.calendar`, `kapsula.unread`, `kapsula.system` | — | `settings.set`, `show`, `media.toggle`, `media.prev`, `media.next` |
| `aura` | `aura.settings`, `aura.voice` | — | `settings.set`, `show` |
| `maska` | `maska.settings`, `maska.voice` | — | `settings.set`, `voice.mute`, `voice.deafen`, `voice.leave`, `call.accept`, `call.decline` |
| `arkada` | `arkada.settings`, `arkada.game`, `arkada.downloads`, `arkada.friends` | `arkada.achievement`, `arkada.invite`, `arkada.message` | `settings.set`, `game.launch`, `library.open`, `invite.accept` |
| `dock` | `dock.settings`, `dock.apps`, `dock.widgets` | — | `settings.set` |
| `smena` | `smena.settings` | — | `settings.set`, `show` |
| `metla` | `metla.settings`, `metla.found` | — | `settings.set`, `show` |

Поля, на которые уже опираются другие приложения (менять их смысл нельзя, добавлять новые — можно):

- `kapsula.media`: `{ "playing", "title", "artist", "app" }` или `null`.
- `kapsula.weather`: `{ "temp", "text", "icon": "clear"|"cloudy"|"rain"|"snow"|"storm"|"fog", "city" }` или `null`.
- `kapsula.calendar`: `{ "events": [ { "title", "start": "ЧЧ:мм", "end": "ЧЧ:мм", "allDay"? } ] }` или `null`.
- `kapsula.unread`: `{ "total", "apps": { "discord", "steam" } }` или `null`.
- `kapsula.system`: `{ "cpu", "ram", "gpu", "down", "up" }` — только пока открыта вкладка «Система» или показана нагрузка в игре.
- `aura.voice`: `{ "on", "mute", "preset", "presetName", "voice" }`.
- `maska.voice`: `{ "inCall", "channel", "mute", "deaf", "video", "speaking", "since", "incoming", … }` или `null`.
- `arkada.game`: `{ "appId", "name", "since" }` или `null`.

Приложение без кнопок-действий в настройках отвечает на `settings.run` ошибкой — это нормально. Страница внутри Discord или Steam не может стать светлой по `hub.theme.mode`: она следует только акценту и «Меньше движения».

## Доставка по HTTP

```
POST /hub/http    { "client": null | "c1-…", "messages": [ … ] }
            →     { "client": "c1-…", "messages": [ … ] }

GET  /hub/http?client=c1-…
            →     { "messages": [ … ] }
```

- Первый `POST` идёт с `"client": null` и сообщением `hello`; в ответе — имя подключения, его надо передавать дальше.
- `GET` хаб держит открытым, пока не появится что передать, но не дольше 20 секунд (тогда `messages` пуст). Клиент сразу повторяет запрос.
- Ответ `410` — хаб такого подключения не знает (перезапустился): надо начать с `hello`.
- Клиент молчит дольше 45 секунд — хаб считает, что он закрылся.

## Правила для приложений

1. **Работать без хаба.** Хаб — дополнение, а не условие запуска.
2. **После переподключения повторить своё состояние.** Клиент из `client.js` делает это сам.
3. **Состояние — целиком.** В `data` всегда полная картина, а не «что изменилось».
4. **Не ломать старое.** В `data` и `args` можно добавлять поля; менять смысл существующих и удалять их — только с новой версией протокола.
5. **Имена тем и команд** — латиницей, через точку: `voice.mute`, `fx.toggle`.
