# Workpackage: Mehretagen-Karten korrekt schlüsseln

Branch: `fix/multi-floor-room-keys`
Scope: `src/lib/map/**`, `src/www/map.ts` (+ getrackter Build `www/app.js`)

---

## 1. Verifikationsergebnis

**Der Befund aus `06-bestandsadapter.md` §5 Punkt 8 ist teils Falsch-Positiv, teils bestätigt.**

### 1.1 Falsch-Positiv: die ioBroker-Objektstruktur ist bereits korrekt zusammengesetzt

Der Bericht schließt aus der Issue-Historie, `mapFlag` allein sei der Schlüssel. Die
Code-Verifikation widerlegt das: der State-Baum ist bereits `(mapFlag, roomId)`.

| Ort | Objekt-ID | Bewertung |
|---|---|---|
| `src/lib/features/vacuum/services/V1MapService.ts:84` (Writer V1) | `Devices.<duid>.floors.<mapFlag>.<roomId>` | korrekt zusammengesetzt |
| `src/lib/features/vacuum/services/B01MapService.ts:197,456` (Writer B01) | `floors.<mapId>[.<roomId>]` | korrekt |
| `src/lib/features/vacuum/b01/q10/Q10ShadowDataService.ts:242,456` (Writer Q10) | `floors.<mapId>.…` | korrekt |
| `src/lib/socketHandler.ts:180` (Reader Web-UI) | `Devices.<duid>.floors.<floor>.<roomId>` | korrekt parametrisiert |
| `src/lib/features/vacuum/b01/B01BaseVacuumFeatures.ts:299` | `floors.<currentMapId>.*` | korrekt etagengebunden |

Namen werden nirgends als Schlüssel benutzt — nur als `common.name` bzw. Anzeigetext.
**Eine Umstellung der Objektstruktur war deshalb nicht nötig und ist nicht erfolgt.**

### 1.2 Bestätigt: zwei Lesepfade verlieren die Etagenbindung

Der reale Fehler sitzt nicht im Schlüssel, sondern in zwei **Lesern**, die den `mapFlag`-Teil
des Schlüssels wegwerfen bzw. raten. Symptom ist exakt das aus §3.3.3 berichtete:
„fehlerhafte Struktur bei gleichnamigen Räumen in verschiedenen Karten".

**(a) `src/lib/map/MapManager.ts` (vorher Zeile 117)**

```ts
const floor = (currentMapIndex != null && currentMapIndex >= 0) ? currentMapIndex : 0;
… await this.adapter.getObjectAsync(`Devices.${duid}.floors.${floor}.${seg.id}`);
```

`currentMapIndex` ist in `V1MapService` mit `-1` initialisiert und bleibt so, bis ein
`map_status` eintrifft. Der Clamp auf `0` liest dann die Raumnamen von Etage 0 und schreibt sie
auf die Segmente einer beliebigen anderen Karte — Raum-IDs wiederholen sich zwischen Karten.
Zusätzlich war Lesen/Schreiben asymmetrisch: der Writer schreibt bei `-1` nach `floors.-1.<id>`,
der Reader las `floors.0.<id>`.

**(b) `src/www/map.ts` (vorher Zeile 685 f.)**

```ts
.sendTo(this.instanceId, "get_room_names", { duid, floor: 0, segmentIds })
… this.roomNamesFromStates[`${duid}.${id}`] = …
```

Drei Fehler auf einmal: Etage **hart auf 0**, Cache-Key **ohne `mapFlag`**, und der
Nachlade-Guard `roomNamesRequestedForDuid` war **pro Gerät** statt pro Karte. Auf einem Gerät mit
zwei Karten bekommt Karte 1 damit die Namen von Karte 0, und nach einem Etagenwechsel wird nie
nachgeladen, weil der Guard schon gesetzt ist. Die `get_room_names`-Gegenstelle
(`socketHandler.ts:172 ff.`) akzeptiert einen `floor`-Parameter — sie wurde nur nie korrekt bedient.

### 1.3 Geprüft und in Ordnung (keine Änderung)

- **Q10/B01-Pipeline:** Räume tragen ihre Namen inline im Payload (`Q10MapCreator.ts:691`), es gibt
  keinen etagenübergreifenden State-Lookup. Der Laufzeit-Cache in `MapManager` ist über
  `mergeQ10RuntimeState`/`isCompatibleQ10OverlaySeed` per `mapId` abgesichert
  (`Q10YxMapParser.ts:1048,1110`, `MapManager.ts:376-386`) — ein Kartenwechsel vermischt keine
  Overlays.
- **V1-Parser:** `mappedRooms` gilt immer für die gerade geladene Karte; die Segmentliste ist
  implizit kartengebunden. Kein Schlüsselfehler.

### 1.4 Außerhalb dieses Pakets gefunden (nicht angefasst)

`src/lib/features/vacuum/v1VacuumFeatures.ts:346` sammelt die selektierten Räume für
`app_segment_clean` über das Muster `floors.*.*` — also **über alle Etagen hinweg**. Ein auf
Etage 0 gesetzter Raum-Schalter startet damit auch Raum gleicher ID auf Etage 1. Das ist derselbe
Befund, liegt aber in `src/lib/features/**` (laut Auftrag gesperrt, anderer Agent). Korrekt wäre,
nur `floors.<currentMapIndex>.*` auszuwerten (so macht es `B01BaseVacuumFeatures.ts:299` bereits).
**Empfehlung an den Feature-Agenten weiterreichen.**

---

## 2. Was geändert wurde

### `src/lib/map/roomKey.ts` (neu, 130 Zeilen)

Ein gemeinsames Modul für die Schlüsselbildung, von Adapter **und** Web-UI genutzt:

- `normalizeMapFlag()` / `normalizeRoomId()` — nicht-negative Ganzzahl oder `null` (unbekannt);
  `UNKNOWN_MAP_FLAG = -1` ist explizit „unbekannt", nicht „Etage 0".
- `floorFolderId()`, `roomStateId()` — Objekt-IDs (`Devices.<duid>.floors.<mapFlag>.<roomId>`,
  unverändert zur bestehenden Struktur).
- `roomNameCacheKey()`, `floorScopeKey()` — Cache-/Guard-Keys inklusive `mapFlag`.
- `toDisplayName()` — `common.name` als String oder Übersetzungsobjekt (vorher hätte ein
  Übersetzungsobjekt `"[object Object]"` ergeben).
- `enrichSegmentNamesFromRoomStates()` — füllt leere Segmentnamen **ausschließlich** aus der
  Etage, zu der die Karte gehört; bei unbekanntem `mapFlag` passiert nichts.

### `src/lib/map/MapManager.ts`

- Kein Clamp mehr auf Etage 0. Ist der Kartenindex unbekannt, wird die Namensanreicherung
  übersprungen und per `rLog(… "debug")` vermerkt. Kein Name ist besser als ein falscher Name.
- Der aufgelöste `mapFlag` wird auf die V1-`mapData` gestempelt, damit nachgelagerte Konsumenten
  (Web-UI, `get_room_names`) den Schlüssel vollständig bilden können.
- Die Leseschleife nutzt jetzt `enrichSegmentNamesFromRoomStates`.

### `src/lib/map/v1/MapParser.ts`

- `ParsedMapData.mapFlag?: number` als dokumentiertes optionales Feld ergänzt (nur Typ).

### `src/www/map.ts`

- `MapData.mapFlag?: number` ergänzt.
- Raumnamen-Cache `roomNamesFromStates` jetzt `"duid.mapFlag.roomId"` statt `"duid.roomId"`.
- Guard `roomNamesRequestedForDuid` → `roomNamesRequestedForFloor` (`"duid.mapFlag"`).
- `get_room_names` sendet `floor: mapFlag` statt `floor: 0`; ohne bekannten `mapFlag` wird
  **gar nicht** angefragt.
- Beim Gerätewechsel wird der Namens-Cache geleert (vorher blieben Namen des Vorgängergeräts
  stehen).
- `www/app.js` + `.map` via `npm run build:www` neu erzeugt (getrackt, mitcommittet).

---

## 3. Migrationsbedarf für bestehende States

**Keiner. Die Änderung ist vollständig abwärtskompatibel.**

- Es wurde **keine** Objekt-ID geändert, umbenannt oder gelöscht. `Devices.<duid>.floors.<mapFlag>.<roomId>`
  war und bleibt die Struktur; bestehende Räume, Namen und Schalter überleben das Update
  unverändert.
- Neu ist nur ein zusätzliches **Feld innerhalb** des JSON-States `Devices.<duid>.map.mapData`
  (`mapFlag`). Das ist ein additive Änderung an einem ohnehin bei jedem Kartenupdate
  überschriebenen JSON; Konsumenten, die es nicht kennen, ignorieren es.
- Die Web-UI verkraftet `mapData` ohne `mapFlag` (Zustand direkt nach dem Update, solange noch die
  alte JSON-Nutzlast im State liegt): sie zeigt dann die vom Parser gelieferten Namen und lädt
  keine Namen nach. Mit dem nächsten Kartenupdate ist `mapFlag` gesetzt und alles läuft.
- Ein Altbestand kann `floors.-1.<roomId>`-Objekte enthalten (vom bisherigen Writer bei noch
  unbekanntem Kartenindex). Diese werden **nicht** automatisch entfernt — das wäre ein
  Löschvorgang an Benutzerobjekten und liegt zudem im gesperrten `features/**`. Sie sind harmlos
  (unbenutzt, sobald der Kartenindex bekannt ist) und können vom Benutzer gelöscht werden.

---

## 4. Neue Tests

`npm run test:unit`: **48 Dateien, 300 Tests, alle grün**, `npm run typecheck` fehlerfrei.
19 der 300 Tests sind neu.

### `src/lib/map/roomKey.test.ts` (14 Tests)

- Objekt-IDs und Cache-Keys enthalten beide Schlüsselteile.
- Gleiche Raum-ID auf zwei Karten ⇒ unterschiedliche Keys (IDs, Cache, Guard-Scope).
- Gleicher Raum**name** auf zwei Karten kollidiert nicht (Name ist kein Schlüssel).
- Normalisierung: `-1`, `undefined`, `""`, `"abc"`, `1.5` gelten als unbekannt.
- `toDisplayName` für String und Übersetzungsobjekt.
- Anreicherung im Mehretagenfall: Karte 0 → Karte-0-Namen, Karte 1 (identische Raum-IDs 16/17,
  teils identischer Name „Hallway") → Karte-1-Namen; es werden nachweislich nur Objekt-IDs der
  eigenen Etage gelesen. Unbekannter `mapFlag` ⇒ kein einziger Lesezugriff.
- Bereits gesetzte Namen werden nicht überschrieben; ungültige Raum-IDs übersprungen.

### `src/lib/map/MapManager.multiFloor.test.ts` (5 Tests)

End-to-end über `MapManager.processMap()` (V1-Zweig, Parser/Creator gestubbt, Adapter-Stub
protokolliert jede gelesene Objekt-ID). Fixture: zwei Karten, Raum-IDs 16/17 in beiden.

- Karte 0 ⇒ „Kitchen"/„Hallway", `mapData.mapFlag === 0`, gelesen wurden nur `floors.0.*`.
- Karte 1 ⇒ „Bedroom"/„Hallway", `mapData.mapFlag === 1`, gelesen wurden nur `floors.1.*`
  (Regression: vorher „Kitchen").
- `currentMapIndex = -1` und `undefined` ⇒ **kein** Fallback auf Etage 0, keine Lesezugriffe,
  kein `mapFlag` im Ergebnis.
- Etagenwechsel hintereinander liefert für dieselbe Raum-ID unterschiedliche Namen.

Damit steigt die Abdeckung von `src/lib/map`: `roomKey.ts` 100 % Statements,
`MapManager.ts` 78 % (vorher deutlich niedriger, da der V1-Zweig gar nicht getestet war).

---

## 5. Erwartete Merge-Konflikte

| Datei | Risiko | Bemerkung |
|---|---|---|
| `www/app.js`, `www/app.js.map` | **hoch** | Generiertes Bundle. Jeder Branch, der `src/www/**` anfasst, kollidiert. Auflösung: Konflikt verwerfen und nach dem Merge einmal `npm run build:www` laufen lassen. |
| `README.md` | **mittel** | Alle Pakete schreiben in denselben `### **WORK IN PROGRESS**`-Block. Textueller Konflikt, beide Einträge behalten. |
| `src/www/map.ts` | **mittel** | Nur wenn ein anderes Paket ebenfalls am Web-Renderer arbeitet. Betroffen sind die Felddeklarationen (~Z. 266), `setupSocketListeners` (~Z. 517) und `drawOverlaysFromMap` (~Z. 665-700). |
| `src/lib/map/MapManager.ts` | **niedrig** | Nur der V1-Anreicherungsblock (~Z. 115-135) und ein Import. |
| `src/lib/map/v1/MapParser.ts` | **niedrig** | Zwei Zeilen im Interface `ParsedMapData`. |
| `src/lib/map/roomKey.ts` + Tests | **keins** | Neue Dateien. |

Nicht angefasst: `requestsHandler.ts`, `localApi.ts`, `mqttApi.ts`, `deviceManager.ts`, `main.ts`,
`admin/**`, `src/lib/features/**`, `package.json`, `io-package.json` (Version unverändert 0.7.4).
