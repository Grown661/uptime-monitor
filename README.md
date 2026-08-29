# uptime-monitor

Kleiner, selbst gehosteter Uptime-Monitor mit Web-Dashboard: prüft die eigenen
Dienste (Homelab, Websites, APIs) in festem Intervall, speichert die History und
zeigt Uptime-Prozent, Antwortzeiten und Ausfälle auf einen Blick.

## Problem

Wer eigene Dienste betreibt, merkt Ausfälle oft erst, wenn jemand anderes sie
meldet. Externe Monitoring-Dienste sind für ein Homelab überdimensioniert oder
kostenpflichtig. `uptime-monitor` ist ein einziger Node-Prozess ohne Abhängigkeiten,
der auf demselben Server nebenherlaufen kann.

## Features

- Ziele (Name + URL) im Web-UI verwalten
- Hintergrund-Check jede Minute (konfigurierbar) via HTTP/HTTPS, misst **Status + Antwortzeit**
- History pro Ziel (letzte 120 Checks), persistiert als JSON
- Dashboard: grün/rot-Status, Uptime-%, Antwortzeit, Balken-History (Höhe = Antwortzeit, rot = down)
- Neues Ziel wird sofort gecheckt, nicht erst beim nächsten Intervall
- Down-Ereignisse werden ins Server-Log geschrieben (einfach an ntfy/Discord anzubinden)

## Stack

- **Node.js** (nur Builtins: `node:http`, `node:https`, `node:crypto`, `node:fs/promises`) — **kein `npm install` nötig**
- Vanilla-JS-Dashboard, Auto-Refresh alle 15 s

## Setup & Start

```bash
node server.js                              # Port 8213, Check alle 60 s
PORT=9000 CHECK_INTERVAL_MS=30000 node server.js
```

Dashboard: `http://localhost:8213`

## API

| Methode | Pfad                | Beschreibung                                        |
| ------- | ------------------- | --------------------------------------------------- |
| GET     | `/api/status`       | Alle Ziele mit Status, Uptime-%, Antwortzeit, History |
| POST    | `/api/targets`      | `{name, url}` — neues Ziel, wird sofort gecheckt    |
| DELETE  | `/api/targets/:id`  | Ziel + History entfernen                            |

## Passt zusammen mit

[`status-page`](../status-page) — liest die hier gesammelten Daten und macht daraus
eine öffentliche Status-Seite.

## Screenshot

_(Screenshot folgt)_

## Lizenz

MIT
