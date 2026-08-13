# Workpackage: Robusteres Request-Handling

Branch: `feature/robust-request-handling` (4 Commits, nicht gepusht)

## Ausgangslage

`requestsHandler.ts` benutzte einen globalen `REQUEST_TIMEOUT = 10000` mit einer einzigen
Ad-hoc-Ausnahme (`method.includes("map") || method.includes("room") → 20000`), einen flachen
1-Sekunden-Retry und keinerlei Kenntnis vom Zustand des Transports. Bei Verbindungsverlust lief
jeder in-flight-Request einzeln in sein Timeout, jeder erzeugte eine eigene Warn-Zeile, und die
Retry-Logik feuerte danach zweimal nach — das ist die Timeout-Welle aus `06-bestandsadapter.md`
§3.3.1.

Bewusst **nicht** angefasst: Die Trennung von Transport-Sequenz (`nextTransportSequenceId`) und
RPC-`id` (`nextMessageId`) ist unverändert. Die Korrelationslogik (`pendingRequests`,
`finishedRequests`, B01-FIFO-Queue, TCP-ACK-Sonderfall bei Map-Requests) wurde nur an den Stellen
berührt, an denen Timer registriert werden.

## Was geändert wurde

### 1. Neues Modul `src/lib/requestPolicy.ts`

Einzige Quelle für alle Zahlen:

- `METHOD_TIMEOUTS_MS` — Tabelle Methode → Timeout, plus `METHOD_TIMEOUT_PATTERNS` als
  Fallback-Regeln für unbekannte Methoden. Stufen: 5 s (heißer Poll-Pfad: `get_status`,
  `get_prop`, `prop.get`), 8 s (kleine Einzel-Reads), 15 s (Listen/Historie), 20 s
  (Bewegungskommandos), 25–30 s (Binärtransfers: Map, Foto).
- `getRequestTimeoutMs(method, override?)` — Vorrang: expliziter Override > Tabelle > Muster >
  Default. Werte werden auf 1 s … 120 s geklemmt.
- `RETRY_POLICY` / `getRetryDelayMs(retryCount, random?)` — exponentiell (1 s, 2 s, 4 s …),
  gedeckelt bei 15 s, ±25 % Jitter. RNG injizierbar, damit Tests deterministisch sind.
- `POLL_POLICY` / `getPollIntervalSeconds(context)` — adaptive Poll-Kadenz.
- `ChannelUnavailableError` + `isChannelUnavailableError()`.

### 2. `src/lib/requestsHandler.ts`

- Timeout kommt jetzt aus `getRequestTimeoutMs`. **Bugfix:** die alte `includes("map")`-Regel hat
  einen explizit übergebenen Timeout überschrieben — `main.ts:2141` (Etagenwechsel) bat um 60 s
  und bekam 20 s. Override gewinnt jetzt.
- `command()` übergibt keinen Sonderfall-Timeout mehr; `load_multi_map` steht in der Tabelle.
- **Fail-fast vor der Queue:** `getChannelUnavailableReason(duid, method)` prüft, ob Cloud (MQTT)
  *und* lokaler TCP-Kanal unten sind. Wenn ja, wirft `sendRequest` sofort einen
  `ChannelUnavailableError` — kein Queue-Slot, kein Timer, keine Wartezeit. Ausgenommen sind
  `get_network_info` / `service.get_net_info`, weil sie Teil der Wiederherstellung sind.
- **Kein Kaskaden-Timeout:** `failPendingRequests(reason, predicate)` und
  `onChannelDown(channel, reason, duid?)` scheitern alle betroffenen in-flight-Requests in einem
  Rutsch. `rejectPendingTcpRequests()` ist jetzt ein dünner Wrapper darüber (Signatur unverändert,
  `localApi.ts` musste nicht angefasst werden).
- **Log-Rauschen:** `logChannelUnavailable()` gibt pro Gerät höchstens eine Warnung pro 60 s aus
  und zählt die unterdrückten mit; bei Rückkehr des Kanals kommt eine Info-Zeile mit der Anzahl.
  `_processResult` behandelt `ChannelUnavailableError` als erwarteten Zustand (Debug, kein Stack).
- `isRetryableError()` gibt für `ChannelUnavailableError` `false` zurück — bei totem Kanal gibt es
  nichts zu wiederholen. Vor jedem Retry wird der Kanal erneut geprüft.
- Retry-Delay über `getRetryDelayMs` statt fix 1000 ms.
- **Timer-Aufräumen (explizit geprüft):**
  - `mqttResetInterval` (24 h) wurde bisher **nie** gelöscht → Leak bei `onUnload`. Jetzt in
    `clearQueue(true)`.
  - Die 60-s-Expiry-Timer von `finishedRequests` (`resolvePendingRequest`) waren untracked →
    jetzt in `finishedRequestTimers`, werden mitgeräumt.
  - Laufende Backoff-Waits werden bei Unload freigegeben (`ADAPTER_STOPPED`) statt zu hängen.
  - `clearQueue(permanent = false)`: `main.ts:clearTimersAndIntervals()` ruft `clearQueue(true)`
    (Unload), `resetMqttApi()` weiterhin `clearQueue()` — der Handler muss danach weiterlaufen.

### 3. `src/lib/deviceManager.ts` — adaptives Polling

Der 1-s-Ticker bleibt. Ersetzt wurde die Entscheidung *ob* ein Gerät gepollt wird:

- vorher: `isSlowTick || (isActive && mainUpdateCount % 2 === 0)` → aktiv = alle 2 s, fest
- jetzt: pro Gerät `nextPollDueAt`, gespeist aus `getPollIntervalSeconds()`
  - Leerlauf: `updateInterval` (unverändert, z. B. 60 s)
  - Reinigung: 5 s (`POLL_POLICY.activeIntervalSeconds`) — **Verhaltensänderung**, vorher 2 s
  - Startup/Laden (`requestsHandler.startupFinished === false`): mindestens 30 s
  - nach Fehlern: 30 s → 60 s → 120 s → … max. 300 s, je Gerät
- Das Intervall wird **nach** einem erfolgreichen Poll mit dem frischen `lastStateCode` neu
  berechnet, damit der Wechsel idle → cleaning sofort greift und nicht erst ein Intervall später.
- `skipPollUntilNextHomeData` entfernt — es war eine grobe Vorstufe des Backoffs und wurde nur an
  genau der ersetzten Fehlerstelle befüllt.
- Cloud-Housekeeping (`updateHomeData`, `updateDeviceInfo`, `updateHomeDataDeviceStatus`) läuft
  weiterhin auf dem Slow-Tick, auch wenn ein Gerät im Backoff ist — das kostet den Roboter nichts.
- `ChannelUnavailableError` im Poll erzeugt kein `catchError` mit Stack mehr.
- `stopPolling()` räumt `nextPollDueAt`, `pollErrorCount`, `pollingDevices`.

### 4. `src/lib/mqttApi.ts` — minimaler Eingriff (dokumentiert)

Eine private Methode `notifyChannelDown(reason)` (5 Zeilen, direkt unter `isConnected()`) und je
eine Aufrufzeile in den bereits existierenden Handlern `disconnect`, `error`, `close`, `offline`
in `subscribe_mqtt_events()`. Alles optional-chained (`this.adapter.requestsHandler?.onChannelDown?.`),
damit ein teilinitialisierter Adapter nicht wirft. Bestehende Zeilen wurden nicht verändert, nur
ergänzt.

### 5. `src/main.ts`

Eine Zeile: `clearTimersAndIntervals()` ruft `this.requestsHandler.clearQueue(true)`.

## Tests

Alle neu, Vitest mit Fake-Timers. `npm run test:unit`: **49 Dateien, 318 Tests, alle grün**,
`Type Errors: no errors`. `npm run typecheck`: sauber. ESLint auf den geänderten Quelldateien:
sauber (die `test/`-Dateien sind per Repo-Config von ESLint ausgenommen).

- `test/unit/request_policy.test.ts` (17 Tests) — Timeout-Tabelle inkl. Ordnung der Stufen,
  Muster-Fallbacks, Override-Vorrang (Regressionstest für den `load_multi_map`-Bug), Clamping;
  Backoff-Progression, Deckel, Jitter-Bandbreite; Poll-Intervalle für idle/aktiv/Startup/Fehler
  inkl. Untergrenze und Cap; `ChannelUnavailableError`-Erkennung.
- `test/unit/request_handling_resilience.test.ts` (14 Tests) — gegen die **echte**
  `requestsHandler`-Klasse mit Stub-Adapter:
  - `get_status` bekommt 5 000 ms, `get_map_v1` 25 000 ms, Override 60 000 ms greift durch
  - Rejection exakt beim Methoden-Timeout, kein zurückbleibender Eintrag in `pendingRequests`
  - Backoff-Delays werden mitgeschrieben und auf Bandbreite + Monotonie geprüft
  - Kanal unten → sofortige Rejection ohne jede Uhrzeit-Bewegung, kein `sendMessage`, kein Retry
  - `onChannelDown` scheitert 4 in-flight-Requests auf einmal; kein Retry-Sturm
  - `rejectPendingTcpRequests` bleibt auf ein Gerät beschränkt
  - 12 Requests bei totem Kanal → genau **eine** Warn-Zeile, danach Recovery-Zeile mit „11
    request(s) were rejected"
  - Fehlermeldung nennt Roboter und Methode
  - `get_network_info` / `service.get_net_info` sind vom Guard ausgenommen
  - nach `clearQueue(true)`: `vi.getTimerCount() === 0`, `mqttResetInterval === undefined`,
    hängende Backoff-Waits werden mit `ADAPTER_STOPPED` freigegeben
  - `clearQueue()` ohne Flag lässt den Handler weiterarbeiten (MQTT-Reset)
- `test/unit/adaptive_polling.test.ts` (6 Tests) — gegen den echten `DeviceManager`:
  Reinigung pollt vielfach häufiger als Leerlauf; Startup bremst auch während der Reinigung;
  Backoff 30/60/120 s und sofortige Erholung danach; kein `catchError`-Spam bei totem Kanal
  (< 8 Versuche in 400 s statt 400); Slow-Tick-Housekeeping läuft trotz Backoff weiter;
  `stopPolling()` räumt den Zustand.

## Was offen blieb

- **`activeIntervalSeconds` von 2 s auf 5 s.** Bewusste Verhaltensänderung zugunsten der Last.
  Wer maximale Reaktivität will, müsste das konfigurierbar machen — dafür wäre ein jsonConfig-Feld
  in `admin/**` nötig, das ist gesperrt. Aktuell nur Konstante in `requestPolicy.ts`.
- **Kein echter Circuit-Breaker mit Half-Open-Zustand.** Der Guard fragt den Live-Zustand von
  `mqtt_api.isConnected()` / `local_api.isConnected(duid)` ab, hält also keinen eigenen
  Zeitzustand. Das reicht gegen die Kaskade, ist aber blind für einen Kanal, der zwar „connected"
  meldet, aber nichts mehr durchlässt (Zombie-Socket). Der TCP-Keepalive in `localApi` deckt das
  für den lokalen Pfad ab, für MQTT gibt es nichts Vergleichbares.
- **`localApi.ts` wurde nicht angefasst.** `rejectPendingTcpRequests()` hat dieselbe Signatur wie
  vorher, `onChannelDown("TCP", …)` ist vorhanden, wird von `localApi` aber (noch) nicht gerufen —
  der bestehende Aufruf in `resetDeviceSocket()` reicht funktional.
- **`RequestManager.timeoutMs`** ist weiterhin ein toter Konstruktorparameter (das Timeout sitzt
  in `RoborockRequest`). Nicht angefasst, weil das die Queue-Konstruktion aller drei Manager
  berührt hätte.
- Integrationstests (`npm run test:integration`) wurden nicht gelaufen (brauchen js-controller).

## Zu erwartende Merge-Konflikte

| Datei | Risiko | Bemerkung |
|---|---|---|
| `src/lib/mqttApi.ts` | **mittel–hoch** | Paralleles Paket arbeitet hier. Meine Änderung: 1 neue private Methode direkt nach `isConnected()` + je 1 Zeile in den 4 Handlern `disconnect`/`error`/`close`/`offline` in `subscribe_mqtt_events()`. Bestehende Zeilen unverändert → Konflikte sollten rein additiv auflösbar sein. Wichtig beim Auflösen: die `notifyChannelDown()`-Aufrufe müssen erhalten bleiben, sonst greift das Fail-Fast bei Cloud-Verlust nicht mehr. |
| `src/lib/localApi.ts` | **keine** | nicht angefasst. |
| `src/lib/requestsHandler.ts` | mittel | Große Umbauten in `sendRequest`, `clearQueue`, `rejectPendingTcpRequests`, `_processResult` und im Feldblock der Klasse. Wer sonst hier arbeitet, kollidiert wahrscheinlich. |
| `src/lib/deviceManager.ts` | mittel | Die komplette `startPolling()`-Schleife ist umgebaut, `skipPollUntilNextHomeData` ist weg. Ein Paket, das dort Poll-Zweige ergänzt, muss neu einsortiert werden. |
| `src/main.ts` | niedrig | Eine Zeile in `clearTimersAndIntervals()`. |
| `README.md` | **hoch (trivial)** | Alle Pakete schreiben in denselben `### **WORK IN PROGRESS**`-Block. Auflösung: beide Listen behalten. |
| `src/lib/requestPolicy.ts`, die 3 Testdateien | keine | neu. |

`src/lib/map/**`, `src/lib/features/**` und `admin/**` wurden nicht berührt.
