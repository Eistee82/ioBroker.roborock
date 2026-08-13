# Arbeitspaket: cloudfreier Betrieb

Branch: `feature/local-only-operation` (5 Commits, nicht gepusht)

## Was umgesetzt wurde

### 1. Manuelle Gerätekonfiguration
Neues Modul `src/lib/manualDevices.ts`: `parseManualDevices()` liest die Konfiguration
`manualDevices` (JSON-Array), validiert `duid`, `localKey` (Längenwarnung bei ≠ 16), `ip`
(IP-Prüfung) und `pv` (Normalisierung auf `1.0`/`A01`/`B01`/`L01`) und liefert Fehler und
Warnungen getrennt zurück. **Der localKey erscheint nie in einer Meldung.** Optional sind
`name`, `model`, `category`, `sn`; ohne Angabe greifen `roborock.vacuum` /
`robot.vacuum.cleaner`, sodass die Fallback-Vacuum-Features anspringen.

`http_api` bekam `applyManualDevices()`, `getManualDevice()` und `hasCloudSession()`.
Manuelle Geräte werden in `getDevices()`, `getMatchedLocalKeys()`, `getRobotModel()` und
`getProductCategory()` eingemischt; bei gleicher `duid` gewinnt der manuelle Eintrag, weil er
eine ausdrückliche Nutzerentscheidung ist. Damit funktioniert der gesamte restliche Adapter
(messageParser, requestsHandler, deviceManager) unverändert ohne Konto.

### 2. Betriebsart „nur lokal"
`connectionMode: "cloud" | "local"`. Bei `local` überspringt `onReady` Cloud-Login,
`updateHomeData`, Asset-Download, MQTT, `processScenes`, `go2rtc`, den Cloud-Netzwerk-Probe
und den stündlichen MQTT-Reset. Der Slow-Tick in `deviceManager` ruft `updateHomeData` nur
noch mit Cloud-Sitzung auf.

**Kein stiller Rückfall:** Cloud-pflichtige Wege scheitern mit klarer Meldung —
`requestsHandler` meldet „Local-only mode is active: … would need the Roborock cloud",
`executeSceneProgram` setzt `sceneQueueStatus = "cloud-required"` und loggt einen Fehler,
`checkForNewFirmware`/`start_go2rtc`/`processScenes` steigen mit Debug-Hinweis aus.

**Ehrlich benannt:** Der Hilfetext am Schalter und eine Startmeldung nennen ausdrücklich,
dass „der Kartenabruf derzeit die Cloud-Verbindung benötigt" (bewusst nicht endgültig
formuliert, siehe offene Punkte). Ist `enable_map_creation` zusätzlich aktiv, warnt der
Adapter beim Start.

### 3. Sichtbarer Verbindungszustand
Neues Modul `src/lib/connectionStatus.ts`. Pro Gerät unter `Devices.<duid>.connection.`:
`local` und `cloud` (`boolean`, Rolle `indicator.connected`), `preferred`
(`string`, Rolle `text`, States `local|cloud|none`) und `ip` (Rolle `info.ip`). Alle
read-only. Aktualisierung ereignisgesteuert beim TCP-Auf-/Abbau plus 5-s-Intervall; das
Intervall wird in `onUnload` gestoppt. Ohne Cloud leitet der Manager zusätzlich
`info.connection` aus dem lokalen Verbindungszustand ab.

### 4. Netzwerkbindung explizit
`udpBindAddress` (jsonConfig-Typ `interface`, also Auswahlliste der Host-Adressen) wird an
`server.bind(58866, addr)` durchgereicht; ungültige Werte werden mit Warnung ignoriert.
`udpDiscoveryEnabled: false` schaltet Discovery komplett ab — dann trägt `applyManualEndpoints()`
die statischen IPs ein und verbindet direkt. Statische IPs sind **sticky**: ein abweichender
Discovery-Fund überschreibt sie nicht. Läuft das Discovery-Fenster ohne einen einzigen
Broadcast ab, weist die Warnung jetzt auf VLAN/WLAN-Isolation/Container-Bridge hin und
empfiehlt feste IP bzw. Interface-Bindung (Geräte senden alle ~5 s, Stille ist also ein
Netzwerkbefund).

Zusätzlich: `local_api` merkt sich **alle** beobachteten Broadcasts (auch ohne passenden
Schlüssel) und `scanForDevices()` stellt sie bereit. Der Admin-Befehl `scanLocalDevices`
(`socketHandler`) liefert `duid`, IP und `pv` — im Nur-Lokal-Betrieb braucht der Nutzer die
`duid`, um überhaupt einen manuellen Eintrag anlegen zu können.

### 5. Eigene MQTT-Client-ID
`buildMqttClientId(mqttUser)` → `mqttUser + "_" + <4 Byte hex>`. Username, Passwort und
Topics bleiben unverändert.

### Nebenbefunde, die mitgenommen wurden
* **`deviceInfo.localKey` war ein Klartext-State.** `updateDeviceInfo` schreibt ihn nicht
  mehr und löscht den Altbestand einmalig beim Start. Auch der Debug-Config-Dump in
  `onReady` redigiert `manualDevices`.
* `getDeviceProtocolVersion` fällt jetzt auf die per UDP beobachtete Version zurück, wenn
  weder Cloud noch manuelle Konfiguration das Gerät kennen (die ersten drei Broadcast-Bytes
  stehen im Klartext).
* `fetchNetworkInfoEndpoint` akzeptiert eine bestehende lokale TCP-Sitzung als Transport,
  nicht mehr nur MQTT.
* Admin-Konfiguration in Tabs „Account & connection" / „Map" / „Advanced" gegliedert und
  dokumentiert, dass der 2FA-Code in den State `roborock.<instance>.loginCode` gehört.

## Betroffene Dateien

Neu: `src/lib/manualDevices.ts`, `src/lib/connectionStatus.ts`,
`test/unit/local_only_operation.test.ts`, `WORKPACKAGE.md`

Geändert: `src/main.ts`, `src/lib/localApi.ts`, `src/lib/httpApi.ts`, `src/lib/mqttApi.ts`,
`src/lib/deviceManager.ts`, `src/lib/socketHandler.ts`, `src/lib/requestsHandler.ts`,
`src/lib/types.d.ts`, `src/lib/mock/MockAdapter.ts`, `io-package.json`,
`admin/jsonConfig.json`, `admin/i18n/*.json` (11 Sprachen, 18 neue Schlüssel), `README.md`,
`test/unit/device_info_online_state.test.ts`, `test/unit/device_online_homedata_sync.test.ts`

## Tests

`test/unit/local_only_operation.test.ts`, 27 Tests in sechs Gruppen: Parser (Defaults,
Fehlersammlung, Duplikate, IP-/pv-Validierung, Geheimhaltung in Meldungen), `http_api` mit
manuellen Geräten (auch Vorrang vor Cloud-Kopie), MQTT-Client-ID, Verbindungs-States (Rollen,
Typen, Kanalwahl, `info.connection` nur im Nur-Lokal-Modus), Netzwerkbindung
(Bind-Adresse, Discovery abschaltbar, sticky statische IP) und der Admin-Netzwerkscan.
Es werden ausschließlich erfundene `duid`/`localKey`-Werte verwendet.

`test/unit/device_info_online_state.test.ts` prüft jetzt zusätzlich, dass der `localKey`
weder als State angelegt noch geschrieben wird und der Altbestand gelöscht wird.

`MockAdapter` bekam `delay()` und `ensureFolder()`.

**Ergebnis:** `npm run typecheck` fehlerfrei, `npm run test:unit` 47 Dateien / 308 Tests grün,
`eslint` auf allen berührten Quelldateien ohne Befund. Zusätzlich validiert
`npx mocha test/validate_configs.js` die neue `jsonConfig.json` gegen das offizielle
ioBroker-Schema (18 passing).

## Bewusst offen geblieben

1. **Kartenabruf im Nur-Lokal-Betrieb.** Nicht angefasst. Ob der lokale Frame-Typ `MAP(7)`
   parallel bedient wird, ist unbelegt; der Modus sagt deshalb „benötigt derzeit die
   Cloud-Verbindung" statt „ist nicht möglich". Sobald das am Gerät gemessen ist, muss nur
   der Hilfetext (`admin/i18n/*`) und `LOCAL_ONLY_LIMITATIONS` nachgezogen werden.
2. **`manualDevices` ist ein JSON-String, keine Tabelle.** Das ist ein bewusster
   Kompromiss: `encryptedNative` verschlüsselt in js-controller nur String-Natives, eine
   `table` (Array) würde nicht verschlüsselt. Die Anweisung „Schlüssel gehören in
   `encryptedNative`" hat Vorrang vor der schöneren Tabelle. Der jsonConfig-Typ `jsonEditor`
   erlaubt kein `help`, deshalb steht die Erklärung als `staticText` direkt darüber.
   Falls später eine Tabelle gewünscht ist, müsste die Verschlüsselung anders gelöst werden.
3. **`pv`-Aushandlung `1.0` → `L01` bei Timeout** ist nicht implementiert. Es gibt nur die
   drei Quellen Cloud-`pv`, manuelle Angabe und UDP-Broadcast (in dieser Reihenfolge).
4. **CONNECT-Rumpf** unverändert bei 21 Byte (17-Byte-Header + int32 keepAlive). Der Hinweis,
   dass python-roborock mit 17 Byte auskommt, wurde nicht umgesetzt — das ist Protokollkern
   und gehört nicht in dieses Paket.
5. **AP-/Onboarding-Modus (UDP 55559)** nicht angefasst; der erste `localKey` muss weiterhin
   über einen einmaligen Cloud-Login beschafft werden.
6. **`region: "asia"`** nur geprüft, nicht geändert: Laut `_appanalysis/01-cloud-auth.md`
   kennt Roborock vier Rechenzentren (`cn`, `us`, `eu`, `ru`), „asia" bildet keines davon ab
   und ist im Adapter auf `api.roborock.com` + Länderkennung `SG` gemappt. Eine Änderung
   würde bestehende Installationen betreffen — bitte gesondert entscheiden.
7. **Cloud-Sitzung ohne Cloud-Modus.** Im Modus „Cloud und lokal" bleibt alles wie bisher;
   es gibt keinen Laufzeitwechsel zwischen den Modi.

## Zu erwartende Merge-Konflikte

* **`src/lib/requestsHandler.ts`** (Paket „requestsHandler"): Genau **eine** Stelle geändert —
  die Fehlermeldung in `RoborockRequest.send()`, wenn Protokoll 101 ohne MQTT-Verbindung
  gesendet werden soll (jetzt mit `connectionStatus?.isLocalOnly()`-Verzweigung). Bewusst
  minimal gehalten. Beim Merge: die Verzweigung erhalten, damit der Modus nicht stillschweigend
  scheitert.
* **`src/lib/features/**` und `src/lib/map/**`**: nicht angefasst. Berührungspunkte nur
  indirekt über `http_api.getRobotModel()`/`getProductCategory()`, die für manuelle Geräte
  jetzt auch ohne Cloud etwas liefern — das erweitert nur den Wertebereich.
* **`src/main.ts`**: umfangreich geändert (onReady-Ablauf, onUnload, `updateDeviceInfo`,
  `getDeviceProtocolVersion`, `processScenes`, `start_go2rtc`, `executeSceneProgram`,
  `checkForNewFirmware`). Wer ebenfalls an `main.ts` arbeitet, sollte auf diesen Branch
  rebasen statt umgekehrt.
* **`admin/jsonConfig.json`**: komplett neu strukturiert (flaches `panel` → `tabs` mit drei
  Panels). Jede parallele Änderung an dieser Datei kollidiert vollständig; die fremden Felder
  müssen dann in das passende Panel einsortiert werden.
* **`admin/i18n/*.json`**: 18 neue Schlüssel je Sprache, angehängt. Konflikte nur bei
  gleichzeitigem Anhängen; der Paritätstest `i18n_key_parity` deckt Auslassungen ab.
* **`io-package.json`**: vier neue `native`-Felder plus je ein Eintrag in `encryptedNative`
  und `protectedNative`.
* **`src/lib/mock/MockAdapter.ts`**: zwei neue Methoden (`delay`, `ensureFolder`) — additiv.
