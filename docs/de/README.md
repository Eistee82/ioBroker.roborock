![Logo](../../admin/roborock.png)

# ioBroker.roborock

Nutzerdokumentation für den Roborock-Adapter für ioBroker. &ndash; [English version](../en/README.md)

Der Adapter verbindet ioBroker mit Roborock-Saugrobotern. Er veröffentlicht den
Roboterzustand, die Verbrauchsteile, die Reinigungshistorie und die Karte und legt für
jeden Befehl, den das angeschlossene Modell kennt, ein beschreibbares Objekt an. Je nach
Konfiguration spricht er mit dem Roboter über das lokale Netz, über die Roborock-Cloud
oder über beides.

Teile dieses Dokuments werden aus dem Quelltext erzeugt, damit die Referenztabellen nicht
von der Implementierung abweichen können. Abschnitte zwischen `BEGIN`/`END`-Kommentaren
schreibt `npm run docs` neu, alles andere ist von Hand geschrieben.

- [Voraussetzungen](#voraussetzungen)
- [Einrichtung](#einrichtung)
- [Referenz](#referenz)
- [FAQ](#faq)

## Voraussetzungen

- Node.js >= 22.0.0
- ioBroker.js-controller >= 6.0.11
- ioBroker.admin >= 7.6.17
- Ein Roborock-Roboter, der bereits in der Roborock-App eingerichtet ist

## Einrichtung

### 1. Adapter installieren und Instanz anlegen

Den Adapter aus dem ioBroker-Repository installieren und eine Instanz anlegen. Der
Konfigurationsdialog hat drei Reiter: **Konto & Verbindung**, **Karte** und
**Erweitert**. Jedes Feld steht unten in der
[Konfigurationsreferenz](#konfigurationsreferenz).

### 2. Verbindungsmodus wählen

Die Einstellung **Verbindungsmodus** entscheidet, ob der Adapter die Roborock-Cloud
überhaupt kontaktieren darf.

| Modus | Wert | Wirkung |
| --- | --- | --- |
| Cloud und lokal | `cloud` | Vorgabe. Der Adapter meldet sich an der Roborock-Cloud an, liest die Geräteliste und bevorzugt danach die lokale Verbindung für Befehle. Es steht der komplette Funktionsumfang zur Verfügung. |
| Nur lokal (kein Cloud-Kontakt) | `local` | Der Adapter schickt keine einzige Anfrage an die Roborock-Cloud. Er benutzt ausschließlich manuell konfigurierte Geräte. Einen automatischen Rückfall auf die Cloud gibt es nicht. |

### 3a. Einrichtung mit Cloud-Konto (Vorgabe)

1. **Verbindungsmodus** auf *Cloud und lokal* stehen lassen.
2. Die **Region** des Roborock-Kontos auswählen.
3. Den Roborock-**Login** eintragen (die E-Mail-Adresse des Kontos).
4. Die **Anmeldemethode** wählen:
   - *E-Mail + 2FA-Code* (Vorgabe): Es wird kein Passwort gespeichert. Nach dem Start der
     Instanz schickt Roborock einen sechsstelligen Code per E-Mail. Im Dialog gibt es
     dafür kein Eingabefeld - den Code stattdessen innerhalb von 15 Minuten nach dem
     Instanzstart in den State `roborock.<instanz>.loginCode` schreiben.
   - *E-Mail + Passwort*: Das Kontopasswort in das Feld **Passwort** eintragen.
5. Speichern und die Instanz starten. Die Roboter des Kontos erscheinen unter
   `roborock.<instanz>.Devices.<duid>`.

### 3b. Einrichtung ohne Cloud (nur lokal)

In diesem Modus muss der Adapter jeden Roboter vorher kennen, denn es gibt keine
Cloud-Geräteliste, die er lesen könnte. Zwei Werte sind pro Roboter zwingend:

- **`duid`** - die Geräte-ID. Sie ist im lokalen Netz sichtbar: Instanz starten und auf
  der Konfigurationsseite **Geräte im Netz suchen** drücken. Der Knopf meldet `duid`,
  IP-Adresse und Protokollversion jedes Roboters, der im LAN sendet.
- **`localKey`** - ein 16 Zeichen langes Gerätegeheimnis. Es lässt sich lokal nicht
  berechnen, und der Adapter veröffentlicht und protokolliert es nie. Es existiert nur in
  der Roborock-Cloud-Geräteliste und ändert sich nur, wenn der Roboter neu angelernt
  wird - es muss also einmal aus dieser Geräteliste ausgelesen werden und kann danach
  dauerhaft hier stehen bleiben.

Die Roboter als JSON-Array in **Manuelle Geräte (JSON)** eintragen:

```json
[
  {
    "duid": "1a2b3c4d5e6f7890",
    "localKey": "0123456789abcdef",
    "ip": "192.168.1.50",
    "pv": "1.0"
  }
]
```

| Feld | Pflicht | Bedeutung |
| --- | --- | --- |
| `duid` | ja | Geräte-ID, wie sie der Netzwerk-Scan meldet. |
| `localKey` | ja | 16 Zeichen langes Gerätegeheimnis aus der Roborock-Cloud-Geräteliste. |
| `ip` | nein | Feste IP-Adresse. Damit ist für diesen Roboter keine UDP-Erkennung nötig. |
| `pv` | nein | Protokollversion: `1.0`, `A01`, `B01` oder `L01`. Vorgabe ist `1.0`. |
| `name`, `model`, `category`, `sn` | nein | Kosmetisch, außer `sn`: das brauchen einige B01-Kartenentschlüsselungen. |

Der Wert wird vom js-controller verschlüsselt gespeichert und nie ins Log geschrieben.

**Was ohne Cloud nicht geht:** Kartenabruf, gespeicherte Szenen, Firmware-Informationen
und Kamera-Streaming brauchen derzeit die Cloud-Verbindung. Im Modus *Nur lokal* schlagen
diese Funktionen mit einer klaren Meldung fehl, statt still auf die Cloud auszuweichen.

### 4. Optional: Karte und Web-Oberfläche

Auf dem Reiter *Karte* **Kartenerzeugung aktivieren** einschalten, damit der Adapter die
Karte rendert. Die Karte, die Raumauswahl sowie die Panels für Station und Verbrauchsteile
zeigt der eigene Web-Reiter des Adapters in der ioBroker-Admin-Oberfläche - eine URL muss
man nicht von Hand eingeben.

Über der Karte steht der Reinigungsmodus - Vac & Mop, Wischen, Saugen - und darunter
Saugkraft, Wischstrecke und Wassermenge als Schaltleisten. Der Modus entscheidet, welche
Stufen angeboten werden: beim Wischen gibt es keine Saugstufe, beim Saugen keine
Wassermenge, und die Saugstufe MAX+ erscheint nur im Modus *Saugen*, weil der Roboter sie
nur dort behält. Ein Moduswechsel schickt alle drei Werte in einem einzigen Aufruf. Ein
Roboter ohne diese Modi behält die einfachen Stufenleisten.

Die Karte selbst ist ein PNG, das der **Adapter** rendert - der Browser zeichnet sie
nicht und kann deshalb einem dunklen Admin nicht von sich aus folgen. Wie sie gemalt
wird, entscheidet **Kartenfarbschema** auf dem Reiter *Karte*: *Hell* ist das Bild, das
der Adapter seit jeher erzeugt, und bleibt die Vorgabe; *Dunkel* nimmt die Boden- und
Wandfarben aus dem dunklen Theme der Roborock-App; *Dem Admin-Theme folgen* übernimmt,
was der Roborock-Reiter meldet. Da es pro Roboter genau ein gerendertes Bild gibt, kann
die letzte Einstellung zwei Browser mit unterschiedlichen Themes nicht getrennt
bedienen - der zuletzt meldende entscheidet, was alle sehen. Ein Wechsel der Einstellung
zeichnet die gespeicherten Karten sofort neu und kostet die Roboter keine einzige
Anfrage.

Die Tafel **Einstellungen** trägt die dauerhaften Roboter-Einstellungen. Heute sind das „Nicht
stören", die Kindersicherung, die Kollisionsvermeidung, der Entleerungsmodus der Station und die
Trocknung; dort werden weitere Einstellungen nach und nach einsortiert. Ein Bedienelement erscheint nur bei einem Roboter, der die Einstellung
wirklich hat, und der Adapter findet das auf zwei Wegen heraus: Manche Einstellungen melden sich im
Status, den der Roboter ohnehin schickt; für die übrigen **fragt der Adapter den Roboter einmal beim
Start**, ob er den zugehörigen Lesebefehl kennt. Wer antwortet, bekommt das Bedienelement; wer mit
`unknown_method` ablehnt, nicht. Ein fehlendes Bedienelement heißt also „kann das Gerät nicht", nie
„ist noch nicht geladen".

Der zweite Weg ersetzt das Raten anhand des Modellnamens, und das war in beide Richtungen falsch:
An einem Roboter gemessen beherrschte er neun Kommandos, die an die Klasse eines anderen Modells
gebunden waren, und elf nicht — zwei Kommandos derselben Funktionsgruppe konnten sich
unterscheiden. Nur das Gerät selbst weiß es. Ist die Antwort etwas, das der Adapter nicht eindeutig
erkennt, gilt die Einstellung als nicht vorhanden, statt ein Bedienelement anzubieten, das
möglicherweise nichts tut: Eine fehlende Funktion fällt auf und lässt sich melden, ein toter
Schalter nicht. Jede Beschriftung ist die, die der
Adapter am Objekt veröffentlicht hat, im Wortlaut der Roborock-App.

„Nicht stören" besteht aus einem Schalter sowie Beginn und Ende. Zwei Eigenheiten sind wissenswert,
weil sie aus dem Protokoll stammen und nicht aus einer Gestaltungsentscheidung: Der Roboter hat
**kein** eigenes Ein/Aus-Feld dafür — das Senden eines Zeitfensters *ist* das Einschalten, und zum
Ausschalten gibt es einen eigenen Befehl, der das Fenster unangetastet lässt. Die Tafel schickt das
Fenster deshalb beim Einschalten, und eine Zeit, die bei ausgeschaltetem Modus geändert wird, bleibt
im Browser stehen und geht erst beim Einschalten an den Roboter. Und das Fenster gilt in der
**Uhr des Roboters**, nicht in der des ioBroker-Hosts: Der Roboter speichert vier nackte Zahlen ohne
Zeitzone, und die Roborock-App hat genau dafür eine eigene Seite für die Gerätezeitzone. Weicht die
Zeitzone des Roboters von der eigenen ab, liegt die Ruhezeit zu einer anderen Stunde als der hier
angezeigten. **Das ist jetzt nachprüfbar:** Kann der Roboter es sagen, steht seine Zeitzone unter
`deviceStatus.timezone` — beim Testgerät `Europe/Berlin`, also dieselbe. Roborock selbst formuliert
den Vorbehalt so: „Eine falsche Roboter-Zeitzone kann sich auf die Genauigkeit des Modus ‚Nicht
stören' auswirken." Der Adapter **liest** die Zeitzone nur; gestellt wird sie weiterhin in der
Roborock-App.

Die Kindersicherung ist ein gewöhnlicher Schalter. Beide Einstellungen sind auch im Objektbaum
lesbar, und beide werden nach dem Senden überprüft: Der Roboter antwortet auch auf eine verworfene
Einstellung mit `["ok"]`, deshalb vergleicht der Adapter das Gewünschte mit dem, was der Roboter
danach meldet, und sagt es im Log, wenn beides nicht zusammenpasst.

Der **Entleerungsmodus** bestimmt, wie kräftig die Station den Staubbehälter leert. Er ist eine
Auswahl aus vier Stufen — *Smart*, *Leicht*, *Mittel* und *Max.* —, in Roborocks eigenem Wortlaut.
Auffällig ist, dass die vier Stufen intern **nicht** 0 bis 3 heißen, sondern 0, 1, 2 und 4: Die
Nummer 3 gibt es im Gerät, sie hat aber in keiner Sprache einen Namen und in der App keinen
Auswahlplatz. Der Adapter bietet sie deshalb nicht an. Meldet ein Roboter von sich aus eine andere
Stufe, wird sie unverändert angezeigt — was das Gerät über sich sagt, ist eine Tatsache — und lässt
sich nur nicht zurückschreiben.

Die **Trocknung** ist eine einzige Auswahl statt eines Schalters und einer Dauer, weil das Protokoll
nur einen Befehl kennt: Er trägt Dauer und Ein/Aus stets gemeinsam. Die Auswahl hat deshalb die
Stellung *Kein Trocknen* und die Dauern 2, 3, 4 und 5 Stunden. Wird auf *Kein Trocknen* gestellt,
schickt der Adapter die zuletzt gemeldete Dauer mit — genau wie die Roborock-App, die dabei
ebenfalls eine Dauer mitsendet. Die eingestellte Dauer und der Ein/Aus-Zustand stehen zusätzlich
unter `deviceStatus.dryer_dry_time` und `deviceStatus.dryer_enabled`. Die 5-Stunden-Stufe kommt in
der App nur auf einer von zwei Trocknungsseiten vor; ob jede Station sie annimmt, ist nicht belegt.
Lehnt eine sie ab, meldet das die Kommandoprüfung im Log.

Sieben weitere Einstellungen sind einfache Ein/Aus-Schalter, und auch hier entscheidet die Frage an
den Roboter, welche davon er bekommt: **Automatische Entleerung**, **Tastenbeleuchtung**, **Entlang
der Bodenrichtung reinigen**, **Angepasster Akkustand**, **FlexiArm-Design: erweiterte Reinigung**
für die Seitenbürste, **FlexiArm-Design: erweitertes Wischen** für die Ecken und **FlexiArm-Design:
erweiterte Reinigung von Ritzen**. Die Tastenbeleuchtung entscheidet, ob die Statusleuchte des
Roboters an bleibt; ist sie aus, erlischt die Leuchte eine Minute nach dem vollständigen Aufladen. Jeder
hängt an seinem eigenen Lesebefehl — kennt ein Roboter einen davon nicht, gibt es dafür schlicht
keinen Schalter; das Testgerät beantwortet gemessen genau einen der fünf. Jede Beschriftung und jede
Erläuterung ist Roborocks eigener Wortlaut. Keiner der fünf steht im Status, den der Roboter von
sich aus schickt, deshalb liest der Adapter jeden beim Start einmal und nach jeder Änderung erneut;
im Ordner `queries` liegt zusätzlich je ein Leseknopf.

Bei einem davon ist ein Vorbehalt nötig, und er stammt von Roborock, nicht von diesem Adapter:
**Entlang der Bodenrichtung reinigen wirkt erst, wenn je Raum eine Bodenrichtung gesetzt ist**, und
das geschieht in der Roborock-App unter *Bodenbelag bearbeiten*. Der Schalter hier schaltet das
Verhalten ein; die Richtungen kann er nicht setzen, weil die beiden Werte, die jener Befehl trägt,
nicht belegt sind.

**Kräftiges Wischen für Ecken** ist ein achter Schalter und der einzige, der auf einem anderen Weg
freigeschaltet wird. Einen Lesebefehl dafür gibt es nirgends — die Roborock-App benutzt auch keinen.
Sie liest die Stellung aus dem Status, den der Roboter von sich aus schickt, und genau das tut
dieser Adapter: Ein Roboter, der das Feld nennt, bekommt den Schalter; ein Roboter, der es nie
nennt, bekommt nichts. Deshalb ist es der einzige Schalter ohne Leseknopf daneben — es gibt nichts
zu drücken. Das Testgerät hat die Funktion nicht, und es sagt das doppelt: Das Feld fehlt in seinem
Status, und das Firmware-Kennzeichen, das die App prüft, ist ebenfalls nicht gesetzt.

Zwei Dinge dazu stammen von Roborock und sind wissenswert. Es ist ein **Einmal-Modus**: Der Roboter
löscht ihn nach einem Lauf voraussichtlich selbst wieder, ein Schalter, der von allein auf Aus
zurückfällt, ist also das Werk des Roboters und kein verlorenes Kommando. Und die App **verweigert
das Einschalten, solange die Wischroute auf Schnell steht**. Diese Regel wird hier nicht erzwungen,
weil sie eine Regel über eine zweite Einstellung ist, die dieser Adapter nicht besitzt; verwirft der
Roboter das Kommando deshalb, zeigt es sich im Log.

**Laden außerhalb der Spitzenzeiten** ist ein zweites Tagesfenster neben Nicht-Stören und genauso
gebaut: Ein Fenster zu schreiben schaltet es ein, ein eigener Knopf schaltet es aus, und dazwischen
gibt es kein Kennzeichen, weil das Protokoll keines hat. Was es bewirkt, sagt Roborock selbst: Der
Roboter lädt nur innerhalb des Fensters vollständig und hält außerhalb eine Mindestladung. Es ist
eine Verzögerung, keine Sperre — auch das schreibt Roborock: eine unfertige Reinigung und die
Mindestladung ziehen zu jeder Stunde Strom.

Eine Regel sollte man kennen, bevor der Roboter ablehnt: **Das Fenster muss mindestens sechs Stunden
umfassen.** Das ist die Grenze der App, und die App dehnt ein kürzeres Fenster stillschweigend auf
sechs Stunden. Dieser Adapter lehnt stattdessen ab und sagt es — denn Dehnen heißt, ein Ende eines
vom Nutzer gesetzten Fensters zu verschieben, und anders als die App weiß der Adapter nicht, welches
Ende gemeint war. Ob der Roboter selbst auf den sechs Stunden besteht, ist nicht belegt; die Grenze
wird eingehalten, weil etwas zu senden, was die App nie senden würde, der Weg ins Ungeprüfte ist.

Die **Lautstärke** der Roboterstimme ist im selben Feld ein Schieberegler, und ein Knopf daneben im
Ordner `commands` lässt den Roboter einmal sprechen, damit sich die Einstellung hören lässt.
Erwähnenswert ist, woher der Bereich kommt: Der Regler der Roborock-App ist enger als der Befehl
zulässt, und wie eng, hängt vom Modell ab — beim Testgerät läuft er von 30 bis 90 in Schritten von
5. Der Adapter bietet stattdessen **0 bis 100** an, denn das ist der Bereich, den die App auf ihrem
Zahleneingabeweg selbst prüft, bevor sie sendet. Das modellabhängige Fenster wird bewusst nicht
übernommen — einen Wertebereich an einen Modellnamen zu binden ist genau das Kriterium, das dieser
Adapter abbaut. Lehnt ein Roboter einen Wert außerhalb seines eigenen Fensters ab, meldet er das,
und die Kommandoprüfung schreibt es auf.

### Die 3D-Karte

Ein Schalter oben rechts kippt die Karte: **2D** ist das Bild, das der Adapter seit jeher zeichnet,
**3D** dieselbe Karte als Boden mit aufgestellten Wänden. Ziehen dreht, Scrollen oder Aufziehen
zoomt, zwei Finger verschieben.

Was zu sehen ist, bleibt ehrlich gegenüber dem, was die Daten hergeben. Der Boden **ist** die
2D-Karte, flach gelegt und als Textur verwendet — genau das tut auch die Roborock-App. Die Wände
sind je ein Quader auf jeder Zelle, die der Roboter als belegt kartiert hat, alle 500 mm hoch; das
ist die feste Höhe der App. Der Roboter misst nicht, wie hoch eine Wand ist, also kann es hier
niemand. Roboter und Station stehen als einfache Körper an ihrer gemeldeten Position. Möbel und die
auf der Karte gespeicherten Zonen — Sperrbereiche, Wischsperrbereiche und unsichtbare Wände —
stehen ebenfalls als Körper darin, während Fahrweg, Wischspur, Raumnamen und die gefundenen
Gegenstände in das Bodenbild gezeichnet sind.

Drei Dinge sind erwähnenswert:

- **Es kostet nichts, solange man es nicht benutzt.** Die 3D-Bibliothek wird erst beim ersten Druck
  auf den Schalter geladen und vorher nie. Eine Installation, die bei 2D bleibt, lädt rund 12 KB
  mehr als bisher, nicht 700.
- **Der Schalter erscheint nur, wenn er funktionieren kann.** Ein Browser ohne WebGL — verbreitet in
  Kiosk-Aufbauten und in Containern ohne GPU-Zugriff — bekommt keinen Schalter statt einer schwarzen
  Fläche. Scheitert die Ansicht trotzdem beim Start, kehrt der Tab zu 2D zurück und sagt warum.
- **Was auf der Karte platziert wird, wird in 2D platziert, egal aus welcher Ansicht heraus.** Die
  auf der Karte gespeicherten Zonen, das Rechteck für eine einzelne Zonenreinigung, der Punkt, zu dem
  der Roboter fahren soll, und die Linie, die einen Raum teilt: alle vier werden flach auf der
  2D-Karte gesetzt. Ein Druck auf einen dieser Knöpfe kehrt deshalb zuerst nach 2D zurück, wo man
  sieht und nachjustiert. Aus demselben Grund wird der Wechsel nach 3D verweigert, solange eines
  davon offen ist, und sagt das, statt es zu verstecken: Eine gespeicherte Zone wartet auf
  „Speichern" im Bedienfeld, ein Reinigungsrechteck auf „Start" — ein Rechteck, das man nicht mehr
  sieht, ist eines, in das der Roboter blind geschickt würde, und eine Trennlinie, die man nicht mehr
  sieht, ist ein Schnitt durch einen Raum ohne Hinsehen. Der Weg **zurück** nach 2D wird nie
  verweigert. Die Ansichtsrückstellung in der Statusleiste gehört allein zur 2D-Karte und fehlt in
  3D deshalb; die 3D-Ansicht richtet man mit dem Drehen selbst wieder aus.

Bei einem Roboter mit mehreren Karten **markiert die Etagenauswahl jetzt die Etage, auf der der
Roboter tatsächlich steht**. Beides fällt auseinander, sobald man den Keller ansieht, während der
Roboter das Erdgeschoss reinigt — und bisher sagte nichts, was was ist. Daneben veröffentlicht der
Adapter unter **Karteninventar**, welche Karte geladen ist und welche **Sicherungen** der Roboter
meldet: beim Testgerät eine je Karte, mit dem Datum der Sicherung und der Etage, zu der sie gehört.

Zu den Sicherungen gehört ein ehrlicher Vorbehalt, und der ist ein eigener Datenpunkt:
`mapInventory.restoreSupported`. Er beantwortet, was die beiden belegten Hälften gemeinsam
beantworten können — ob der Roboter überhaupt Sicherungen führt und ob seine Firmware das
Wiederherstellungsmenü anbietet (`new_feature_info`, Bit 49). Beim Testgerät trifft beides zu, die
Roborock-App würde für seine zwei Sicherungen also einen Eintrag zeigen. **Der Datenpunkt sagt
nicht, dass Wiederherstellen funktioniert**, sondern nur, dass die App es anbieten würde:
`recover_multi_map` ist ein Schreibbefehl, der die gerade geladene Karte überschreibt, und einen
Roboter einen zerstörerischen Aufruf beweisen zu lassen, indem man ihn ausführt, ist keine
Fähigkeitsprüfung. Nichts hiervon löscht, sichert oder stellt eine Karte wieder her; alle drei sind
zerstörerisch und gehören hinter eine Rückfrage.

Die ganze Liste erscheint zusätzlich als ein einziger Wert, `mapInventory.maps`: eine Zeile je Karte
mit `mapFlag`, `name`, `addTime`, `backupCount` und `lastBackupTime`. Sie steht neben den
`floors`-Ordnern, weil sie bei jedem Lesen der Kartenliste neu geschrieben wird — **auch bei dem
Lesen, das eine Umbenennung beurteilt**. Damit ist sie die frischeste Quelle der Namen, und aus ihr
wird die Kartenliste im Admin-Tab gezeichnet.

**Umbenennen gibt es dagegen**, als `commands.name_multi_map`, und es nimmt
`{"mapFlag": 0, "name": "Keller"}` — die Kartennummer, wie sie unter `floors` und in der
Karteninventur steht, und den neuen Namen. Zwei Dinge lehnt der Adapter ab, bevor überhaupt etwas
gesendet wird, weil die Roborock-App sie ebenfalls ablehnt: einen Namen, den eine andere Karte schon
trägt, und einen zu langen. Die Längengrenze ist nicht die Zeichenzahl. Der Roboter zählt einen
einfachen Buchstaben als eins, einen Umlaut als zwei und die meisten anderen Zeichen als drei, und
der Name muss **unter 30** davon bleiben — fünfzehn Umlaute sind also bereits zu lang. Danach wird
die Kartenliste neu gelesen, und nur sie entscheidet: Das Kommando meldet entweder, dass der Roboter
den neuen Namen trägt, oder dass er weiterhin den alten meldet, oder dass sich die Liste nicht lesen
ließ und es damit unbekannt ist. Der Aufruf selbst hat keine Antwort, der man glauben könnte.

Im Admin-Tab hat dasselbe eine eigene Tafel: **Karten**, in der Spalte rechts. Sie listet jede
gespeicherte Karte mit Namen, dem Zeitpunkt der letzten Speicherung und einem Hinweis, ob eine
Sicherung vorliegt, markiert die Karte, auf der der Roboter gerade steht, und trägt das Umbenennen.
Sie hängt bewusst nicht an der Etagenauswahl oben. Die wird aus `commands.load_multi_map` gefüllt,
einem Objekt, das der Adapter nur bei Platz für mehr als eine Karte anlegt, und sie blendet sich bei
nur einer Karte ganz aus — ein Roboter mit einer einzigen Karte hätte also gar kein Umbenennen
bekommen. **Umgeschaltet wird weiterhin mit der Auswahl oben**; die Tafel verwaltet und schaltet
nie. Die Sicherungszeile berichtet, was der Roboter vorhält, und bietet dazu nichts an — aus den
Gründen oben. Das Umbenennen **verschwindet**, statt grau zu werden, wenn der Adapter für diesen
Roboter kein `name_multi_map` veröffentlicht hat, und das Eingabefeld endet dort, wo auch der
Roboter endet: Es zählt die oben beschriebenen Byte und zeigt an, wie viele der dreißig verbraucht
sind — in einer Sprache mit Umlauten lohnt sich der Blick.

Unter **Geräteinformationen** erscheinen die **Seriennummer** des Roboters und sein **Regionsblock**,
beides rein lesend und beides nur bei einem Roboter, der darauf antwortet: das verwendete
Sprachpaket, Roborocks `bom`-Zeichenkette, die Region, die Sprache seiner Stimme und die Zeitzone,
in der er seine Uhr führt. Zwei Dinge sind Absicht. Das `bom` steht unter diesem Namen und nicht als
„Firmware-Version", denn das Testgerät meldet Firmware `V02.26.80` **und** `bom: A.03.0309` — zwei
verschiedene Zeichenketten für einen Roboter, und nichts belegt, welche Roborock als Version meint.
Und die Seriennummer taucht in keiner Logzeile auf, auch nicht auf Debug-Ebene: sie bezeichnet genau
eine Maschine.

Unter **Reinigungsinformationen** liegt außerdem die **Restschätzung** des Roboters: geschätzte
Gesamt- und Restfläche, Gesamt- und Restdauer, Fortschritt in Prozent, der für die Restfläche
erwartete Akkuverbrauch sowie Zeit und Akku je Quadratmeter. Diese Werte ergeben nur während eines
Laufs Sinn; in der Station beschreiben sie den zuletzt beendeten. Der Adapter fragt sie nicht von
sich aus ab — dafür gibt es einen Knopf im Ordner `queries`.

Der **Reinigungsverlauf** steht unter der Stationstafel und ist wie seine Nachbarn
eingeklappt. Er listet die aufgezeichneten Läufe, neueste zuerst, mit dem Beginn, der Dauer,
der gereinigten Fläche und der Art des Laufs — ganze Wohnung, Zone, Raumauswahl — und markiert
nur die Läufe, die der Roboter nicht zu Ende gebracht hat; eine Markierung an jedem normalen
Lauf sagt nichts. Über der Liste stehen die Gesamtwerte, die der Roboter führt: Gesamtfläche,
Gesamtzeit, Anzahl der Läufe.

Ein Klick auf einen Lauf öffnet ihn vollständig — **mitsamt der Karte dieses Laufs**. Der
Adapter holt und rendert diese Karten seit jeher; angezeigt hat sie bisher nichts. Sie
entstehen nur, solange **Kartenerzeugung aktivieren** eingeschaltet ist; ist sie aus, stehen
die Läufe mit allen Werten trotzdem in der Liste, und die Detailansicht sagt, warum es kein
Bild gibt. Das Bild wird erst beim Öffnen eines Laufs geladen, nicht mit der Liste — zwanzig
gespeicherte Karten kosten also nichts, solange keine davon angesehen wird.

Alles in diesem Bereich wird aus dem Objektbaum gelesen; die Tafel schickt dem Roboter nichts.
Die Bezeichnungen der Laufarten und der Abbruchgründe sind Roborocks eigene, aus den Tabellen
der App übernommen; einen Code, den diese Tabellen nicht führen, zeigt der Verlauf als nackte
Zahl, statt ihm einen erfundenen Namen zu geben. Werte, deren Bedeutung nicht belegt ist — ein
B01- oder Q10-Gerät veröffentlicht mehrere davon — stehen unter *Weitere Werte* mit dem Namen
und der Einheit ihres eigenen Objekts.

**Zeitpläne: manche Roboter führen sie selbst, andere lassen sie auf dem Roborock-Server liegen.**
Was von beidem ein Roboter tut, hängt nicht am Modell — die App entscheidet es anhand eines
Merkmals, das der Roboter über sich selbst meldet. Bei einem Roboter der zweiten Art ist die Liste,
die der Adapter bisher gelesen hat, schlicht leer; ein Zeitplan, der täglich läuft, tauchte im
ioBroker also gar nicht auf. Solche Zeitpläne werden jetzt mit ihrer Kennung und ihrem Ein-/Aus-Zustand
aufgeführt.

Was **nicht** dabei ist, ist ihr Inhalt. Die App setzt ihre Zeitplanliste aus zwei Quellen zusammen:
Der Roboter liefert die Kennungen, die Uhrzeiten, Räume und Reinigungsmodi kommen aus dem
Roborock-Konto. Über die lokale Verbindung sind sie nicht lesbar, und dieser Adapter holt sie nicht.
Aus demselben Grund ist der Schalter eines solchen Zeitplans hier nur lesbar: Ihn ein- oder
auszuschalten bräuchte einen Befehl, dessen Form nicht belegt ist — und ein Schalter am falschen
Befehl sähe aus, als arbeite er, und täte nichts.

**Einen Gerätezeitplan zu schalten, bestätigt die Liste des Roboters, nicht seine Antwort.** Der
Roboter antwortet auf den Schaltbefehl mit `ok`, und das heißt nur, dass er ihn angenommen hat —
deshalb liest der Adapter danach die Zeitplanliste erneut (bis zu dreimal über zwei Sekunden, weil
ein Roboter einen Moment brauchen kann) und bestätigt den Schalter mit dem, was die Liste meldet.
Steht der Zeitplan weiterhin andersherum, zeigt der State den Wert des Roboters und trägt den Grund,
warum das Schalten nicht angekommen ist. Genauso bei einem Befehl, der nicht hinausging, abgelehnt
wurde oder in eine Zeitüberschreitung lief: Der Grund steht als Qualität und Kommentar am State
selbst statt nur im Log. Ein Fall bleibt bewusst still — ist der Zeitplan zwischenzeitlich aus der
Liste verschwunden, wird über ihn gar nichts behauptet, weil es keinen Zeitplan mehr gibt, über den
sich etwas behaupten ließe.

Ob ein Zeitplan als **eingeschaltet** gilt, wird für beide Listenarten gleich entschieden: nicht,
indem gefragt wird, ob der Roboter `on` gesagt hat, sondern ob er eines der Wörter gesagt hat, die
„aus" bedeuten. Zwei Schreibweisen sind bekannt und sie widersprechen sich — die App prüft auf
`disable`, der vermessene Roboter antwortete `on` —, also ist eine dritte möglich, und ein laufender
Zeitplan würde hier sonst als ausgeschaltet angezeigt. Der sichtbare Fehler ist der harmlosere.

**Löschen geht dagegen.** Jeder Zeitplan hat einen Knopf `delete` und daneben ein `source`, das
sagt, welche der beiden Arten er ist; der Adapter schickt den passenden Befehl und fragt danach die
Liste des Roboters erneut ab. Erst wenn die Kennung darin nicht mehr auftaucht, gilt der Zeitplan
als gelöscht und sein Ordner verschwindet — meldet der Roboter ihn weiterhin, bleibt der Ordner
stehen, und der Knopf sagt, dass die Löschung nicht angekommen ist. **Zurück geht es nicht:** Der
Adapter kann einen Zeitplan schalten, aber keinen schreiben; ein gelöschter Zeitplan muss in der
Roborock-App neu angelegt werden.

Bei einem Zeitplan vom Server ist eine Grenze vor dem Drücken wichtig. Die App löscht einen solchen
Zeitplan an zwei Stellen — im Roboter und im Roborock-Konto —, und von hier aus ist nur der Roboter
erreichbar. Die Kopie im Konto bleibt, deshalb führt die Handy-App den Zeitplan weiterhin auf und
zeigt ihn als eingeschaltet, obwohl der Roboter ihn nicht mehr kennt. Der Knopf sagt das ebenfalls.

**Das alles steht jetzt auch im Tab.** Neben den Einstellungen liegt eine Tafel *Zeitpläne*,
eingeklappt wie ihre Nachbarn und bei einem Roboter ohne Zeitplan gar nicht vorhanden. Jede Zeile
trägt oben die Startzeit, darunter die Wochentage, daneben eine Marke, ob der Zeitplan im Roboter
oder auf dem Server liegt, und — sofern sie angeboten werden dürfen — den Schalter und das Löschen.
Die Warnung von oben steht in der Tafel **vor** dem Löschen, nicht danach. Ein Zeitplan, dessen Art
der Adapter nicht festhalten konnte, bekommt eine Zeile, die zeigt, was er tut, und gar keine
Bedienelemente; das ist der Fall bei B01 und Q10, deren Zeitpläne aus Datenpunkten stammen, die
keiner der beiden Löschbefehle erreicht. Einen Zeitplan, dessen Zeit dieser Stand nicht lesen kann,
zeigt die Tafel mit dem Text des Roboters statt mit einer gedeuteten Zeit, und bei einem Zeitplan vom
Server steht dabei, warum überhaupt keine Zeit erscheint. Einen Zeitplan **anlegen** kann man in der
Tafel bewusst nicht — aus dem oben genannten Grund: Der Adapter kann keinen schreiben. Und die
Zeiten sind die des Roboters; er führt seine Zeitpläne in seiner eigenen Zeitzone aus, genau die,
die die App zu jedem gespeicherten Zeitplan mitschreibt.

Die Ladestation zeichnet die Karte mit der Grafik, die auch die Roborock-App dafür
verwendet, und dreht sie so, wie der Roboter die Ausrichtung der Station meldet. Welche
Grafik es wird, hängt vom gemeldeten Stationstyp ab: eine einfache Ladeschale bekommt eine
andere als eine Station, die absaugt, wäscht oder trocknet. Diese Grafiken stammen aus dem
Geräte-Plugin, das der Adapter aus dem Roborock-Konto lädt - eine Instanz im Modus *Nur
lokal* hat sie also nie erhalten und behält das eingebaute Stationssymbol. Dasselbe gilt
für einen Roboter, der gar keinen Stationstyp meldet, und für die Karten der
B01/Q10-Pipelines.

### Den Roboter von Hand fahren

Das Feld **Fernsteuerung** fährt den Roboter über ein Steuerkreuz, so wie es die
Roborock-App tut. Es erscheint nur bei einem Roboter, dessen eigene Firmware meldet, dass er
sich fahren lässt; ein Roboter ohne diese Meldung bekommt weder das Feld noch die Objekte -
es gibt also nichts zu drücken, was ins Leere liefe.

**Gefahren wird nur, solange eine Taste gedrückt ist.** Jeder Schritt, den der Roboter
bekommt, trägt eine Frist von 1,5 Sekunden und wird etwa alle 0,4 Sekunden erneuert - so
macht es die App, und darin liegt die ganze Sicherung. Wird der Browser-Tab geschlossen, in
den Hintergrund geschoben, verliert er die Verbindung oder friert er ein, kommt kein weiterer
Schritt an, und der Roboter hält binnen anderthalb Sekunden von selbst an. Der Adapter
wiederholt von sich aus keinen Schritt, ein verlorengegangenes „Stopp" kann also keinen
fahrenden Roboter zurücklassen. Bei geöffnetem Feld funktionieren zusätzlich die Pfeiltasten
für die vier geraden Richtungen; die Diagonalen bleiben auf dem Steuerkreuz.

Das Starten ist ein Modus, kein einzelner Befehl, und das Verlassen ein eigener. Der Adapter
beendet den Modus deshalb von selbst nach zwei Sekunden ohne Anweisung, beendet ihn beim
Herunterfahren, und beendet beim nächsten Start einen Modus, den ein früherer Adapterlauf
offen gelassen hat. Letzteres gilt ausschließlich für eine Sitzung, die dieser Adapter selbst
geöffnet hat - einen Roboter, der gerade aus der Handy-App gefahren wird, lässt er in Ruhe.

Zwei Dinge tut er bewusst nicht. Er unterbricht keine laufende Aufgabe stillschweigend:
reinigt der Roboter, fährt er zur Station oder zu einem Punkt, fragt das Feld erst nach und
hält die Aufgabe dann an, bevor es startet - genau wie die App. Und während der Roboter eine
Firmware installiert, lehnt er ab.

Eine **Positionsanzeige während der Fernsteuerung gibt es nicht**, und das ist keine Lücke.
Der Roboter schreibt seine Position nur etwa alle drei Sekunden fort; ein Marker auf der
Karte wäre der Maschine im Raum also bis zu drei Sekunden hinterher - das ist schlechter als
keiner, weil es aktuell aussieht. Die Roborock-App zeigt auf ihrer Fernsteuerseite aus
demselben Grund gar keine Karte. Roborocks eigener Hinweis steht oben im Feld: den Roboter im
Blick behalten.

Für Skripte liegen dieselben vier Aufrufe im Ordner `remoteControl`: eine Starttaste, eine
Richtung mit den neun Stellungen, die die App ausdrücken kann, ein Stopp und ein Ende. Eine
geschriebene Richtung fährt einen Schritt - höchstens 1,5 Sekunden -, ein Skript muss sie
also wiederholen, um weiterzufahren, und der Adapter schließt den Modus zwei Sekunden nach
der letzten ohnehin.

## Referenz

<!-- BEGIN:config -->

### Konfigurationsreferenz

Alle Einstellungen der Adapter-Instanz, entnommen aus der Admin-Konfigurationsbeschreibung.

#### Konto & Verbindung

> JSON-Array, ein Objekt je Gerät: {"duid": "...", "localKey": "...", "ip": "192.168.1.50", "pv": "1.0"}. Optional: name, model, category, sn. Der localKey ist ein 16 Zeichen langes Gerätegeheimnis, das nur in der Roborock-Cloud-Geräteliste steht und lokal nicht ableitbar ist; er ändert sich nur beim Neu-Pairing. Melden Sie sich einmalig mit Ihrem Konto an, um ihn auszulesen, und hinterlegen Sie ihn dann hier. Er wird verschlüsselt gespeichert und nie ins Log geschrieben.

| Einstellung | Schlüssel | Typ | Vorgabe | Beschreibung |
| --- | --- | --- | --- | --- |
| Anmeldemethode | `loginMethod` | `select` | `"email"` | Bei „E-Mail + 2FA-Code“ sendet Roborock einen sechsstelligen Code per E-Mail. Hier gibt es kein Eingabefeld dafür: Tragen Sie den Code innerhalb von 15 Minuten nach dem Adapterstart in den State roborock.&lt;instance&gt;.loginCode ein.<br>Auswahl: `email` = E-Mail + 2FA-Code, `password` = E-Mail + Passwort<br>Ausgeblendet, wenn `data.connectionMode === 'local'` |
| Region | `region` | `select` | `"eu"` | Auswahl: `eu` = Europa, `us` = Vereinigte Staaten, `cn` = China, `asia` = Asien<br>Ausgeblendet, wenn `data.connectionMode === 'local'` |
| E-Mail | `username` | `text` |  | Ausgeblendet, wenn `data.connectionMode === 'local'` |
| Passwort | `password` | `password` |  | Ausgeblendet, wenn `data.loginMethod !== 'password' \|\| data.connectionMode === 'local'` |
| Verbindungsmodus | `connectionMode` | `select` | `"cloud"` | Nur lokal: Der Adapter nimmt keinen Kontakt zur Roborock-Cloud auf. Das setzt manuell konfigurierte Geräte mit duid und localKey voraus. Cloud-gestützte Funktionen bleiben in diesem Modus nicht verfügbar – der Kartenabruf benötigt derzeit die Cloud-Verbindung, ebenso gespeicherte Szenen, Firmware-Informationen und der Kamera-Stream. Es gibt keinen automatischen Rückfall auf die Cloud.<br>Auswahl: `cloud` = Cloud und lokal, `local` = Nur lokal (kein Cloud-Kontakt) |
| Manuelle Geräte (JSON) | `manualDevices` | `jsonEditor` | `""` | JSON-Array aus { duid, localKey, ip, pv }. Der localKey ist ein Gerätegeheimnis und wird verschlüsselt gespeichert. |
| Geräte im Netz suchen | `scanLocalDevices` | `sendTo` |  | Hört auf Geräte-Broadcasts und meldet duid, IP-Adresse und Protokollversion, damit ein manueller Eintrag auch ohne Cloud-Konto angelegt werden kann. Die Adapterinstanz muss laufen. |

#### Karte

| Einstellung | Schlüssel | Typ | Vorgabe | Beschreibung |
| --- | --- | --- | --- | --- |
| Kartenerstellung aktivieren | `enable_map_creation` | `checkbox` |  |  |
| Kartendesign | `map_theme` | `select` | `"dark"` | Betrifft nur die Raumfarben. Boden, Wände und Fahrspur werden über das Kartenfarbschema darunter eingestellt.<br>Auswahl: `dark` = Dunkel, `light` = Hell<br>Ausgeblendet, wenn `!data.enable_map_creation` |
| Kartenfarbschema | `map_color_scheme` | `select` | `"light"` | Boden, Wände und Fahrspur der gerenderten Karte. „Hell“ ist das Bild, das der Adapter seit jeher erzeugt. „Dem Admin-Theme folgen“ übernimmt das Theme, das der Roborock-Tab meldet; da es pro Roboter nur ein gerendertes Bild gibt, entscheidet der zuletzt meldende Browser, was alle sehen.<br>Auswahl: `light` = Hell, `dark` = Dunkel, `auto` = Dem Admin-Theme folgen<br>Ausgeblendet, wenn `!data.enable_map_creation` |

#### Erweitert

| Einstellung | Schlüssel | Typ | Vorgabe | Beschreibung |
| --- | --- | --- | --- | --- |
| Aktualisierungsintervall (Sekunden) | `updateInterval` | `number` |  | Sekunden zwischen zwei Abfragen, während der Roboter im Ruhezustand oder in der Station ist. In diesem Zustand ändert sich nichts, ein langes Intervall kostet also nichts; ein kurzes erzeugt nur zusätzlichen Netzwerkverkehr und Last auf Roboter und ioBroker. |
| Aktualisierungsintervall während der Reinigung | `activePollInterval` | `number` | `5` | Sekunden zwischen zwei Abfragen, während der Roboter reinigt, zurückfährt oder wischt. Kleinere Werte lassen Position, Fläche und Fortschritt enger folgen, aber jede Abfrage ist eine Anfrage: Sie kostet Netzwerkverkehr und Last auf dem Roboter und auf ioBroker. Unter etwa 3 Sekunden ist der Gewinn kaum noch sichtbar. |
| Maximale Wartezeit nach fehlgeschlagenen Abfragen | `pollBackoffMaxInterval` | `number` | `300` | Nach einer fehlgeschlagenen Abfrage wartet der Adapter 30 Sekunden und verdoppelt die Wartezeit nach jedem weiteren Fehlschlag, bis zu dieser Obergrenze. Ein niedriger Wert bemerkt einen zurückkehrenden Roboter früher, versucht es aber weiter gegen ein nicht erreichbares Gerät; ein hoher Wert hält Log und Netzwerk bei einer längeren Störung ruhig. |
| Live-Aktualisierung der Karte | `liveMapInterval` | `number` | `3` | Sekunden zwischen zwei Prüfungen auf Kartenänderungen, während der Roboter reinigt; im Stillstand wartet der Adapter doppelt so lange. Die Prüfung selbst ist eine kleine Anfrage, die nur nach den Änderungen fragt, und eine vollständige Karte wird nur übertragen, wenn sich tatsächlich etwas geändert hat - ein kleiner Wert kostet also weit weniger, als es aussieht, bleibt aber eine Anfrage pro Intervall an den Roboter, das Netzwerk und ioBroker. Roboter ohne inkrementelle Karte müssen jedes Mal die ganze Karte übertragen und werden deshalb nie häufiger als alle 5 Sekunden geprüft. 0 schaltet die Live-Aktualisierung ab; die Karte wird dann nur noch von der normalen Abfrage erneuert. |
| Live-Position: Pause zwischen Aktualisierungen (ms) | `liveTrackInterval` | `number` | `1500` | Millisekunden, die der Adapter nach einer Antwort wartet, bevor er die Roboterposition erneut abfragt. Es ist eine Pause, kein fester Takt: Die nächste Frage geht erst raus, wenn die vorige Antwort da ist. Dadurch können sich die Anfragen nie stapeln, und eine langsame Verbindung verlangsamt einfach die Aktualisierung. Die Vorgabe von 1500 ms stammt aus einer Messung am fahrenden Roboter: Er schreibt seine Position nur etwa alle 3 Sekunden fort, weshalb in einem Test mit 100 ms 95 Prozent aller Anfragen denselben Wert lieferten wie zuvor. 1500 ms tastet das rund zweimal je Fortschreibung ab, was genügt, um keinen Schritt zu überspringen. Ein kürzerer Wert bringt den Roboter nicht dazu, häufiger zu melden — er erzeugt nur mehr Anfragen, und die angezeigte Position ist im Mittel etwa 1,5 Sekunden alt, ganz gleich was hier steht, denn das ist das Fortschreibungsraster des Roboters selbst. 250 ms ist der schnellste erlaubte Wert, deutlich unter der Vorgabe, damit ein Modell, das schneller meldet als das gemessene, nicht ausgebremst wird. Zwei Grenzen gelten automatisch und lassen sich nicht unterschreiten: Solange der Roboter stillsteht und solange er nur über die Roborock-Cloud erreichbar ist, beträgt die Pause mindestens 2 Sekunden. 0 schaltet die Live-Position ab; der Roboter wird dann nur dort gezeigt, wo ihn die letzte Karte hingesetzt hat. Werte von 1 bis 30 werden weiterhin als die ganzen Sekunden gelesen, die diese Option früher zählte, damit eine bestehende Einstellung weiter funktioniert — für die neue Einheit einen Wert ab 250 eintragen. |
| Live-Position: am Roboter ausrichten | `liveTrackAuto` | `checkbox` | `true` | Lässt den Adapter selbst herausfinden, wie oft dieser Roboter seine Position fortschreibt, und richtet den Takt der Live-Position danach. Ausschalten, um stattdessen den festen Wert darüber zu verwenden. Die Vorgabe von 1500 ms wurde an einem Roboter gemessen; ein Roboter, der dreimal so schnell meldet, würde davon ausgebremst, und sein Besitzer erführe nie, dass es dafür eine Einstellung gibt. Gemessen wird der Abstand zwischen zwei Beobachtungen einer Änderung, nicht der Zeitpunkt, zu dem der Roboter sie geschrieben hat — und nie feiner als die Pause, mit der gerade gearbeitet wird. Ein schnellerer Roboter wird deshalb schrittweise erkannt und nicht auf einen Schlag. Gezählt wird nur ein Roboter, der wirklich arbeitet, nie einer, der in der Station steht; das Ergebnis unterschreitet nie den schnellsten erlaubten Wert und überschreitet nie die zwei Sekunden, die ein stehender Roboter bekommt. Worauf sich der Adapter eingependelt hat, steht im Log und im nur lesbaren State map.liveTrackLearnedPause des jeweiligen Roboters. Steht der Wert darüber auf 0, ist die Live-Position ganz abgeschaltet, und diese Option kann sie nicht wieder einschalten. |
| Ausführung gespeicherter Programme | `sceneExecutionMode` | `select` | `"local"` | Lokal: führt die gespeicherte Szene lokal mit ihren Roborock-Szenenschritten aus und nutzt lokale Queue/Fortsetzen. Cloud: startet dieselbe Szene über die Roborock-Cloud wie die App. Es gibt keinen automatischen Wechsel.<br>Auswahl: `local` = Lokal mit Adapter-Queue, `cloud` = Cloud wie Roborock-App |
| Auf Geräte-Broadcasts hören (UDP 58866) | `udpDiscoveryEnabled` | `checkbox` | `true` | Aus: Es werden nur Geräte mit statisch konfigurierter IP-Adresse verwendet. Hilfreich, wenn Broadcasts gefiltert werden (VLAN, WLAN-Client-Isolation, LXC- oder Docker-Bridges). |
| Netzwerkschnittstelle für die Gerätesuche | `udpBindAddress` | `interface` |  | IP-Adresse oder Schnittstellenname (zum Beispiel eth0), an die der UDP-Discovery-Socket gebunden wird. Leer bedeutet alle Schnittstellen, was auf Hosts mit mehreren Netzen fehlschlagen kann.<br>Ausgeblendet, wenn `!data.udpDiscoveryEnabled` |
| Hostname/IP für Kamerastream | `hostname_ip` | `text` |  |  |
| PIN für Kamerastream | `cameraPin` | `number` |  |  |

<!-- END:config -->

### Objektbaum

Alle Geräteobjekte liegen unter `roborock.<instanz>.Devices.<duid>`:

| Ordner | Inhalt |
| --- | --- |
| `commands` | Beschreibbare Knöpfe und Wertobjekte, die eine Reinigung starten, Modi umschalten und so weiter. |
| `queries` | Beschreibbare Objekte, die eine bestimmte Information beim Roboter abfragen. |
| `settings` | Beschreibbare Objekte, die eine dauerhafte Robotereinstellung ändern. `set_dnd_timer` nimmt das Zeitfenster für „Nicht stören" als `HH:MM-HH:MM`; das Einschalten des Modus *ist* dasselbe wie das Schreiben eines Fensters. `close_dnd_timer` schaltet ihn aus, `set_child_lock_status` ist ein einfacher Schalter. Das aktuell gültige Fenster steht nur lesbar in `deviceStatus.dnd_start` und `deviceStatus.dnd_end`, ob es aktiv ist in `deviceStatus.dnd_enabled`. |
| `deviceStatus` | Der Zustand, den der Roboter meldet. Nur lesbar. |
| `consumables` | Restlaufzeit und Betriebsdauer von Bürsten, Filtern und Sensoren. |
| `resetConsumables` | Je ein Knopf pro zurücksetzbarem Verbrauchsteil. |
| `cleaningInfo` | Gesamtwerte über die Lebensdauer (Fläche, Zeit, Anzahl der Läufe). |
| `cleaningInfo.records.<index>` | Die einzelnen Reinigungsläufe der Historie, neueste zuerst; die gerenderte Karte je Lauf liegt unter `map`. |
| `floors` | Ein Eintrag je gespeicherter Karte, inklusive Knopf zum Laden. |
| `schedules` | Die Zeitpläne des Roboters, in drei Ausprägungen. Ein Zeitplan, den ein **V1**-Roboter selbst führt, hat `cron`, einen schreibbaren Schalter `enabled`, `source: "device"` und einen Knopf `delete`. Ein Roboter, der seine Zeitpläne stattdessen auf dem **Roborock-Server** führt, bekommt je Zeitplan einen Eintrag mit `source: "server"`, einem **nur lesbaren** `enabled`, einem Knopf `delete` und `raw` — dem Eintrag genau so, wie der Roboter ihn gemeldet hat. Siehe unten. Bei einem **B01/Q10**-Roboter kommen die Zeitpläne über einen Tuya-Datenpunkt: `enabled` ist dort **ebenfalls nur lesbar**, und es gibt weder `source` noch `delete` — der Schreibbefehl dafür ist nicht belegt, und ein Schalter an einem Befehl, den dieses Gerät nicht spricht, sähe aus, als arbeite er. |
| `programs` | Die in der Roborock-App gespeicherten Szenen — siehe unten. |
| `map` | Die gerenderte Karte und die Raumnamen. Drei Bilder, weil sie verschiedene Fragen beantworten: `map.mapBase64` ist das vollständige, `map.mapBase64Clean` zeigt nur die Raumflächen, und `map.mapBase64Surface` liegt dazwischen — alles, was **auf** dem Boden liegt (Teppiche, Fahrspur, gewischter Bereich, Prognosepfad, Raumnamen, Hindernissymbole), und nichts, was **im** Raum steht (Zonen, virtuelle Wände, Roboter, Ladestation, Go-to-Pin). Mit dem letzten belegt die 3D-Ansicht ihren Boden; es entsteht nur bei Robotern, deren Karte der Adapter selbst zeichnet. Ein B01/Q10-Roboter hat keines, dort nimmt die 3D-Ansicht das saubere Bild. `map.liveTrackLearnedPause` meldet nur lesbar die Pause, die der Adapter für die Live-Position dieses Roboters ermittelt hat — siehe **Live-Position: am Roboter ausrichten** in den Einstellungen. Der State bleibt leer, solange noch nicht genug Positionswechsel gesehen wurden und solange die Option ausgeschaltet ist. |
| `deviceInfo`, `networkInfo`, `connection` | Modell- und Firmware-Informationen, Netzwerkdaten und der Zustand der lokalen bzw. Cloud-Kanäle. |
| `dockingStationStatus` | Stationszustände, nur bei Modellen mit einer Station, die sie meldet. |

#### Gespeicherte Programme

Die Kacheln, die die Roborock-App über ihrer Karte zeigt, sind **Szenen** aus dem Roborock-Konto.
Jede davon erscheint als `programs.<sceneId>`, und die ganze Liste zusätzlich als ein JSON-Wert in
`programs.list` — den liest der Admin-Tab.

| State | Typ | Schreibbar | Beschreibung |
| --- | --- | --- | --- |
| `programs.list` | `string` (JSON) | nein | Alle Programme dieses Roboters auf einmal: `id`, `name`, `enabled`, `valid` und `steps`. |
| `programs.startProgram` | `string` | ja | Auswahl aller Programme; das Schreiben einer ID startet dieses eine. |
| `programs.<id>.name` | `string` | nein | Der in der App vergebene Name. |
| `programs.<id>.enabled` | `boolean` | nein | Ob das Programm in der App eingeschaltet ist. Starten lässt es sich hier so oder so. |
| `programs.<id>.start` | `boolean` | ja | Knopf. Führt dieses Programm aus. |
| `programs.<id>.steps` | `string` (JSON) | nein | Die Befehle, die das Programm sendet, mit Ziel und Reinigungswerten. Bei mehrstufigen Programmen die vollständige Auskunft. |
| `programs.<id>.target` | `string` | nein | `segment`, `zone` oder `all`. Leer, wenn die Schritte sich unterscheiden. |
| `programs.<id>.targetIds` | `string` (JSON) | nein | Die Segment- oder Zonen-IDs, z. B. `[18]`. |
| `programs.<id>.mapFlag` | `number` | nein | Zu welcher gespeicherten Karte das Programm gehört. |
| `programs.<id>.fanPower` | `number` | nein | Saugstufe. Leer, wenn die Schritte sich unterscheiden. |
| `programs.<id>.waterBoxMode` | `number` | nein | Wasserstufe. Leer, wenn die Schritte sich unterscheiden. |
| `programs.<id>.mopMode` | `number` | nein | Wischroute. Leer, wenn die Schritte sich unterscheiden. |
| `programs.<id>.repeat` | `number` | nein | Anzahl der Durchgänge. |
| `programs.<id>.mode` | `string` | nein | `vacuum`, `mop` oder `vacmop`, aus Saug- und Wasserstufe abgeleitet. |
| `programs.<id>.valid` | `boolean` | nein | **Nur vorhanden, wenn der Roboter geantwortet hat.** `false` heißt: der Roboter kennt das Ziel dieses Programms nicht mehr — vermutlich wurde die Karte neu aufgebaut, und ein Start bewirkt nichts. |

Drei Eigenschaften sind wissenswert:

- **Die Einzelwerte werden nur geschrieben, wenn alle Schritte übereinstimmen.** Ein Programm, das
  die Wohnung erst saugt und dann wischt, hat zwei verschiedene Saugstufen; `fanPower` bleibt dann
  leer, statt eine davon auszuwählen. In `steps` stehen immer beide.
- **Namen und Einstellungen kommen aus der Cloud.** Der Roboter selbst kennt nur eine interne
  Kennung und eine Geometrie. Im cloudfreien Betrieb existiert dieser Ordner deshalb gar nicht — das
  liegt an Roborocks Aufbau, nicht am Adapter.
- **Ein mehrstufiges Programm dauert so lange, wie seine Läufe dauern.** Im lokalen Modus schickt
  der Adapter einen Schritt, wartet, bis der Roboter wirklich in diese Art Reinigungslauf gegangen
  ist und bis er samt Station wieder stabil im Ruhezustand ist, und schickt erst dann den nächsten.
  Direkt hintereinander gesendet verwirft der Roboter alle bis auf einen. `programs.sceneQueueLength`
  und `programs.sceneQueueStatus` bleiben deshalb über das ganze Programm belegt, und die
  Warteschlange übersteht einen Adapter-Neustart. Startet ein Schritt nicht, wird er bis zu dreimal
  wiederholt; danach läuft das Programm mit einer Meldung im Log weiter — an einem vom Roboter
  ignorierten Schritt kann es also nicht hängen bleiben.

#### Was aus einem Befehl geworden ist

Ein Befehlsobjekt zu beschreiben ist eine Bitte, kein Ergebnis. Der Roboter wird erst danach
gefragt, und er kann ablehnen, gar nicht antworten oder mit `["ok"]` antworten und weitermachen wie
bisher. Bisher stand das nur im Adapterlog, ein Bedienelement konnte also Erfolg melden für etwas,
das nie passiert ist.

Der Befehls-State sagt es jetzt selbst. Es gibt keinen zusätzlichen State zum Nachsehen — das
Zustandsmodell von ioBroker trägt es bereits:

| Der Befehls-State | Was das heißt |
| --- | --- |
| `ack: false`, Qualität `0` | Jemand will das. Bekannt ist noch nichts. |
| `ack: true`, Qualität `0` | Der Roboter hat es übernommen. |
| Qualität **nicht** `0`, Kommentar gesetzt | Es wurde versucht und hat nicht geklappt. Der Kommentar sagt, warum. |

Die Qualität ist das, was von einem Fehlschlag in der Objektansicht zu sehen ist, und sie benennt
den Verursacher so genau, wie es ehrlich geht:

| Qualität | Bedeutung hier |
| --- | --- |
| `0x42` Gerät nicht verbunden | Weder der lokale noch der Cloud-Kanal stand. Es wurde nichts gesendet — sicher. |
| `0x11` allgemeines Instanzproblem | Der Adapter konnte die Anfrage nicht einmal bauen. Es wurde nichts gesendet — sicher. |
| `0x44` Gerät meldet Fehler | Der Roboter hat etwas anderes als `["ok"]` geantwortet. Er hat abgelehnt. |
| `0x41` allgemeines Geräteproblem | Der Roboter hat quittiert und meldet weiterhin etwas anderes. Der Wert ist nicht wirksam geworden. |
| `0x01` schlecht | Entweder kam gar nichts zurück, oder unterwegs ist etwas kaputtgegangen. **Ob der Roboter den Befehl ausgeführt hat, ist unbekannt.** |

Die letzte Zeile ist Absicht. Ein Timeout ist keine Ablehnung, und von außen kann dieser Adapter die
beiden nicht unterscheiden — eine Qualität, die einen Verursacher benennt, würde mehr behaupten,
als irgendjemand weiß. Welcher der beiden Fälle es war, steht im Kommentar.

Der Kommentar enthält den Grund als JSON, damit er auf zwei Arten zugleich lesbar ist: `m` ist ein
englischer Satz für alle, die direkt auf den State schauen, `k` und `a` sind ein
Übersetzungsschlüssel samt Argumenten — daraus baut der Admin-Tab den Text in Ihrer Sprache.

Drei Dinge folgen daraus, die man wissen sollte:

* **Der Wert bleibt stehen.** Ein fehlgeschlagener Befehl lässt den State unbestätigt zurück, mit
  dem gewünschten Wert darin. Der nächste Versuch räumt die Qualität von selbst ab, und ein
  Befehl, der funktioniert, räumt sie ebenfalls ab.
* **Eine Taste springt in jedem Fall zurück.** Eine Sekunde nach dem Druck steht sie wieder auf
  `false` mit `ack: true` — sie ist ja wirklich nicht mehr gedrückt —, behält aber Qualität und
  Kommentar des Versuchs.
* **Raumreinigung, Zonenreinigung und Punktfahrt** schickt der Tab direkt, ohne einen State zu
  schreiben. Ihr Ergebnis erscheint trotzdem an ihren Befehlsobjekten `commands.app_segment_clean`,
  `commands.app_zoned_clean` und `commands.app_goto_target`. Der Etagenwechsel meldet an der
  gedrückten Taste `floors.<karte>.load`.

Eine Einschränkung, weil man leicht darüber stolpert: **`ioBroker.javascript` verwirft
Zustandsänderungen, deren Qualität nicht `0` ist**, solange ein Trigger nichts anderes sagt. Ein
Skript, das auf einen Befehls-State hört, wird von einem Fehlschlag also nicht geweckt. Vorher wurde
dort im Fehlerfall überhaupt nichts geschrieben — es heißt aber: Die Qualität ist ein Merkmal zum
Nachsehen, keine Benachrichtigung.

Der Admin-Tab zeigt die Fehlschläge an: rot bei einem benannten, gelb bei den beiden, die die Frage
offenlassen. Ein Befehl, der einfach funktioniert hat, wird nicht gemeldet: Dort wartet nichts auf
eine Bestätigung, und eine Meldung pro erfolgreichem Befehl würde einen daran gewöhnen, genau den
Kanal zu übersehen, der gelesen werden muss, wenn etwas kaputtgeht.

Neben den Tank- und Staubbeutelzuständen enthält `dockingStationStatus`, was die Station
gerade mit dem Mopp macht. Der Roboter meldet das als rohe Zahlen in `deviceStatus`
(`wash_status`, `wash_phase`, `wash_ready`, `dry_status`, `rdt`); diese sechs States sind
dieselben Zahlen, gelesen wie die Roborock-App sie liest:

| State | Bedeutung |
| --- | --- |
| `isWashing` | Ein Waschvorgang läuft (das untere Byte von `wash_status` ist nicht 0). |
| `washingTaskStatus` | Genau dieses untere Byte. Belegt ist nur „ungleich 0"; der Wertebereich ist nirgends aufgezählt, deshalb bleibt es eine reine Zahl. |
| `washingMode` | Das obere Byte von `wash_status`, also *welche* Wäsche läuft. Vier Modi haben einen Text; jeder andere Wert behält seine Zahl, statt sich ein Etikett zu leihen. Nur aussagekräftig, solange `isWashing` wahr ist. |
| `isWashReady` | Die Station kann sofort waschen, ohne dass der Roboter erst zurückfahren muss. |
| `isDrying` | Die Station trocknet den Mopp (`dry_status = 1`). |
| `dryRemainTime` | Restminuten der Trocknung, aus `rdt` (das in `deviceStatus` in Sekunden stehen bleibt). |

Ein Gerät, das keines der rohen Felder meldet, bekommt auch keinen dieser States.
`wash_phase` behält seine eigene Werteliste in `deviceStatus` und bekommt keinen
abgeleiteten State, weil nur zwei seiner Werte überhaupt irgendwo belegt sind.

Drei Objekte liegen nicht unter einem Gerät, sondern direkt in der Instanz:

| State | Inhalt |
| --- | --- |
| `loginCode` | Hier wird der sechsstellige Code aus der Login-Mail eingetragen. |
| `mapTheme` | `light` oder `dark`: das Theme, das der Roborock-Admin-Tab zuletzt gemeldet hat. Wird nur ausgewertet, solange **Kartenfarbschema** auf *Dem Admin-Theme folgen* steht; von Hand geschrieben (aus einem Skript oder einer Visualisierung) wirkt es genauso wie die Meldung des Tabs. |
| `mapColorScheme` | `light` oder `dark`: der Farbsatz, mit dem die Karte tatsächlich gezeichnet wird — also **Kartenfarbschema**, aufgelöst gegen `mapTheme`. Nur lesbar. Der Admin-Tab liest ihn, um Reinigungszonen und Raummarkierung in den Farben der darunterliegenden Karte zu zeichnen; das ist nicht dieselbe Entscheidung wie das Hell/Dunkel-Theme des Admins. |

Objektnamen und Wertelisten übersetzt der Adapter zur Laufzeit, soweit die
Roboter-Firmware Übersetzungen liefert. Die folgenden Tabellen zeigen die englischen
Vorgaben aus dem Quelltext; die Objekt-IDs selbst sind sprachunabhängig.

<!-- BEGIN:states -->

### States-Referenz

Alle Objekte liegen unter `roborock.<instanz>.Devices.<duid>`. Beschreibbare Befehlsobjekte stehen in den folgenden Ordnern, die vom Roboter gemeldeten Werte weiter unten.

#### `commands`

Beschreibbare Objekte in `Devices.<duid>.commands`.

| Objekt | Name | Typ | Rolle | Vorgabe | Werte / Bereich | Modelle |
| --- | --- | --- | --- | --- | --- | --- |
| `add_no_go_zone` | Add no-go zone ([x1,y1,x2,y2] or four corners, in mm) | `string` | `json` | `""` |  | 33/34 |
| `add_no_mop_zone` | Add no-mop zone ([x1,y1,x2,y2] or four corners, in mm) | `string` | `json` | `""` |  | 33/34 |
| `add_virtual_wall` | Add invisible wall ([xStart,yStart,xEnd,yEnd] in mm) | `string` | `json` | `""` |  | 33/34 |
| `app_amethyst_drain_all_water` | Drain All Water | `boolean` | `button` | `false` |  | 1/34 |
| `app_amethyst_self_check` | Run Self Check | `boolean` | `button` | `false` |  | 1/34 |
| `app_arm_direction_move` | Arm Direction Move | `number` | `value` | `1` | `1` = Up<br>`2` = Down<br>`3` = Go<br>`4` = Back | 1/34 |
| `app_arm_in_compartment` | Arm In | `boolean` | `button` | `false` |  | 1/34 |
| `app_arm_move` | Arm Move | `string` | `json` |  |  | 1/34 |
| `app_arm_move_preset` | Arm Move Preset | `string` | `value` | `"[2,0,0]"` | `[2,0,0]` = M3 Left<br>`[1,0,0]` = M3 Right<br>`[0,1,0]` = M4 Left<br>`[0,2,0]` = M4 Right<br>`[0,0,2]` = M5 Left<br>`[0,0,1]` = M5 Right | 1/34 |
| `app_arm_out_compartment` | Arm Out | `boolean` | `button` | `false` |  | 1/34 |
| `app_arm_recover` | Recover Arm | `boolean` | `button` | `false` |  | 1/34 |
| `app_arm_recover_payload` | Recover Arm Payload | `string` | `json` |  |  | 1/34 |
| `app_change_camera` | Mechanical Camera | `number` | `value` | `0` | `0` = Disable Mechanical Camera<br>`1` = Enable Mechanical Camera | 1/34 |
| `app_charge` | Charge | `boolean` | `button` | `false` |  | alle |
| `app_copy_program` | Copy Program | `string` | `json` |  |  | 1/34 |
| `app_delete_program` | Delete Program | `number` | `value` | `1` | &ge; 1 | 1/34 |
| `app_delete_tidy_up_record` | Delete Tidy-Up Record | `number` | `value` | `0` |  | 1/34 |
| `app_delete_wifi` | Delete Saved Wi-Fi | `number` | `value` | `0` |  | 1/34 |
| `app_empty_inbuilt_water_tank` | Drain Built-In Water Tank | `boolean` | `button` | `false` |  | 1/34 |
| `app_empty_rinse_tank_water` | Empty Rinse Tank Water | `boolean` | `button` | `false` |  | 1/34 |
| `app_exhibition_action` | Exhibition Action | `string` | `json` |  |  | 1/34 |
| `app_exhibition_enter_exit` | Exhibition Mode | `number` | `value` | `0` | `0` = Exit<br>`1` = Enter | 1/34 |
| `app_goto_target` | Go To Target | `string` | `json` |  |  | 33/34 |
| `app_grip` | Close Gripper | `boolean` | `button` | `false` |  | 1/34 |
| `app_ignore_dirty_objects` | Ignore Dirty Objects | `string` | `json` |  |  | 1/34 |
| `app_keep_easter_egg` | Keep Easter Egg Mode | `boolean` | `button` | `false` |  | 1/34 |
| `app_modify_program` | Modify Program | `string` | `json` |  |  | 1/34 |
| `app_open_gripper` | Open Gripper | `boolean` | `button` | `false` |  | 1/34 |
| `app_pause` | Pause | `boolean` | `button` | `false` |  | alle |
| `app_pick_up` | Arm Pick-Up Action | `number` | `value` | `0` | `0` = Auto Grab<br>`1` = Manual Grab | 1/34 |
| `app_pick_up_enter_exit` | Arm Grab Mode | `number` | `value` | `0` | `0` = Exit / Off<br>`1` = Manual Mode<br>`2` = Auto Mode | 1/34 |
| `app_program_enter_exit` | Program Enter / Exit | `number` | `value` | `0` | `0` = Exit<br>`1` = Enter | 1/34 |
| `app_put_down` | Arm Put-Down Action | `number` | `value` | `0` | `0` = Put Down | 1/34 |
| `app_rc_lds_lifting` | LDS Lifting | `number` | `value` | `0` | `0` = Lower<br>`1` = Lift Up | 1/34 |
| `app_rc_roller_mop` | Roller Mop Command | `number` | `value` | `0` | `0` = In<br>`1` = Out | 1/34 |
| `app_rc_roller_mop_cover` | Roller Mop Cover Command | `number` | `value` | `0` | `0` = Stretch Out<br>`1` = Retract | 1/34 |
| `app_resume_build_map` | Resume Quick Build Map | `boolean` | `button` | `false` |  | 1/34 |
| `app_resume_patrol` | Resume Patrol | `boolean` | `button` | `false` |  | 1/34 |
| `app_save_beautification_pic` | Save Beautification Picture | `boolean` | `button` | `false` |  | 1/34 |
| `app_save_program` | Save Program | `string` | `json` |  |  | 1/34 |
| `app_segment_clean` | Segment Cleaning | `boolean` | `button` | `false` |  | alle |
| `app_segment_clean_subdivision` | Segment Clean Subdivision | `string` | `json` |  |  | 1/34 |
| `app_set_dirty_replenish_clean_status` | Set Dirty Replenish Clean Status | `string` | `json` |  |  | 1/34 |
| `app_set_dynamic_config` | Set Dynamic Config | `string` | `json` |  |  | 1/34 |
| `app_set_ignore_stuck_point` | Set Ignore Stuck Point | `string` | `json` |  |  | 1/34 |
| `app_set_low_space_zones` | Set Low Space Zones | `string` | `json` |  |  | 1/34 |
| `app_set_smart_cliff_forbidden` | Set Smart Cliff Forbidden | `string` | `json` |  |  | 1/34 |
| `app_skip_current_cleaning_area` | Skip Current Cleaning Area | `string` | `json` |  |  | 1/34 |
| `app_spot` | Spot Cleaning | `boolean` | `button` | `false` |  | 33/34 |
| `app_start` | Start | `boolean` | `button` | `false` |  | alle |
| `app_start_build_map` | Start Quick Build Map | `boolean` | `button` | `false` |  | 1/34 |
| `app_start_collect_dust` | Start Collect Dust | `boolean` | `button` | `false` |  | 17/34 |
| `app_start_easter_egg` | Start Easter Egg Attack | `boolean` | `button` | `false` |  | 1/34 |
| `app_start_mop_drying` | Start Mop Drying | `boolean` | `button` | `false` |  | 16/34 |
| `app_start_patrol` | Start Patrol | `string` | `json` |  |  | 1/34 |
| `app_start_pet_patrol` | Start Pet Search | `boolean` | `button` | `false` |  | 1/34 |
| `app_start_program` | Start Program | `string` | `json` |  |  | 1/34 |
| `app_start_replenish_clean_area` | Start Replenish Clean Area | `string` | `json` |  |  | 1/34 |
| `app_start_tidy_up` | Start Tidy-Up | `string` | `json` |  |  | 1/34 |
| `app_start_wash` | Start Mop Wash | `boolean` | `button` | `false` |  | 16/34 |
| `app_stop` | Stop | `boolean` | `button` | `false` |  | alle |
| `app_stop_collect_dust` | Stop Collect Dust | `boolean` | `button` | `false` |  | 1/34 |
| `app_stop_grasp` | Stop Grasp | `boolean` | `button` | `false` |  | 1/34 |
| `app_stop_mop_drying` | Stop Mop Drying | `boolean` | `button` | `false` |  | 16/34 |
| `app_stop_wash` | Stop Mop Wash | `boolean` | `button` | `false` |  | 16/34 |
| `app_switch_dock_cool_fan` | Dock Cool Fan | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `app_wakeup_robot` | Wake Up Robot | `boolean` | `button` | `false` |  | 1/34 |
| `app_zoned_clean` | Zone Clean | `string` | `json` |  |  | 33/34 |
| `app_zoned_clean_subdivision` | Zoned Clean Subdivision | `string` | `json` |  |  | 1/34 |
| `carpet_turbo` | carpet_turbo | `boolean` | `switch` | `false` |  | 1/34 |
| `child_lock` | child_lock | `boolean` | `switch` | `false` |  | 1/34 |
| `clean_path_preference` | clean_path_preference | `number` | `value` | `0` | `0` = Standard<br>`1` = Fast<br>`2` = Deep | 1/34 |
| `find_me` | Find Me | `boolean` | `button` | `false` |  | alle |
| `green_laser` | green_laser | `boolean` | `switch` | `true` |  | 1/34 |
| `light_mode` | light_mode | `boolean` | `switch` | `true` |  | 1/34 |
| `load_multi_map` | Load Map | `number` | `level` | `0` |  | 33/34 |
| `merge_segment` | Combine rooms ([segmentId, segmentId, ...]) | `string` | `json` | `""` |  | 33/34 |
| `mode` | mode | `number` | `value` | `0` | `0` = Vacuum<br>`1` = Vacuum & Mop<br>`2` = Mop | 1/34 |
| `name_segment` | Rename rooms ([{"segmentId":16,"name":"Kitchen","tag":14}]) | `string` | `json` | `""` |  | 33/34 |
| `remove_map_zone` | Remove a wall or zone ({"kind":"no_go","index":0}, or "all") | `string` | `json` | `""` |  | 33/34 |
| `repeat_state` | repeat_state | `number` | `value` | `0` | `0` = Off<br>`1` = On | 1/34 |
| `resume_segment_clean` | Resume Segment Clean | `boolean` | `button` | `false` |  | 33/34 |
| `resume_zoned_clean` | Resume Zone Clean | `boolean` | `button` | `false` |  | 33/34 |
| `save_furnitures` | Furniture ([1,id,x0,y0,x1,y1,x2,y2,x3,y3,type,subType,direction] adds, [0,id] deletes) | `string` | `json` | `""` |  | 33/34 |
| `set_carpet_clean_mode` | Carpet Avoidance Mode | `number` | `value.list` | `0` | `0` = Avoid<br>`1` = Rise<br>`2` = Ignore<br>`3` = Dynamic Lift | 33/34 |
| `set_carpet_mode` | Carpet Boost | `string` | `json` | `""` |  | 33/34 |
| `set_clean_motor_mode` | Set Cleaning Mode | `string` | `value` |  | modellabhängig | 33/34 |
| `set_clean_repeat_times` | Clean Repeat Times | `number` | `value` | `1` | `1` = 1x<br>`2` = 2x | 33/34 |
| `set_clean_sequence` | Cleaning order (segment IDs, [] resets) | `string` | `json` | `"[]"` |  | 33/34 |
| `set_custom_mode` | Fan Power | `number` | `level` |  | modellabhängig | 33/34 |
| `set_mop_mode` | Mop Mode | `number` | `level` |  | modellabhängig | 33/34 |
| `set_voice_chat_volume` | Set Voice Chat Volume | `number` | `value` | `0` |  | 1/34 |
| `set_water_box_custom_mode` | Water Box Mode | `number` | `level` |  | modellabhängig | 33/34 |
| `set_water_box_distance_off` | Water Box Distance Off (1-30) | `number` | `level` | `1` | 1 … 30 | 2/34 |
| `split_segment` | Divide a room ([segmentId, x1, y1, x2, y2] in mm) | `string` | `json` | `""` |  | 33/34 |
| `start_camera_preview` | Start Camera Preview | `string` | `json` |  |  | 1/34 |
| `start_new_easter_egg` | Start New Easter Egg | `number` | `value` | `0` | `0` = Dance | 1/34 |
| `start_voice_chat` | Start Voice Chat | `string` | `json` |  |  | 1/34 |
| `start_wash_then_charge` | Start Wash Then Charge | `boolean` | `button` | `false` |  | 1/34 |
| `stop_camera_preview` | Stop Camera Preview | `string` | `json` |  |  | 1/34 |
| `stop_segment_clean` | Stop Segment Clean | `boolean` | `button` | `false` |  | 33/34 |
| `stop_voice_chat` | Stop Voice Chat | `boolean` | `button` | `false` |  | 1/34 |
| `stop_zoned_clean` | Stop Zone Clean | `boolean` | `button` | `false` |  | 33/34 |
| `update_map` | Update Map | `boolean` | `button` | `false` |  | 1/34 |
| `update_map_zone` | Move or resize a wall or zone ({"kind":"no_go","index":0,"zone":[x0,y0,x1,y1,x2,y2,x3,y3]}) | `string` | `json` | `""` |  | 33/34 |
| `water` | water | `number` | `value` | `1` | `1` = Low<br>`2` = Medium<br>`3` = High | 1/34 |
| `wind` | wind | `number` | `value` | `2` | `1` = Quiet<br>`2` = Balanced<br>`3` = Turbo<br>`4` = Max<br>`5` = Max+ | 1/34 |

#### `queries`

Beschreibbare Objekte in `Devices.<duid>.queries`.

| Objekt | Name | Typ | Rolle | Vorgabe | Werte / Bereich | Modelle |
| --- | --- | --- | --- | --- | --- | --- |
| `app_get_arm_joints_data` | Get Arm Joints Data | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_carpet_deep_clean_status` | Get Carpet Deep Clean Status | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_clean_estimate_info` | Get Clean Estimate Info | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_dryer_setting` | Get Dryer Setting | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_program` | Get Program | `number` | `value` | `1` | &ge; 1 | 1/34 |
| `app_get_program_runtime` | Get Program Runtime | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_program_soundlist` | Get Program Sound List | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_programs_summary` | Get Program Summary | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_robot_setting` | Get Robot Setting | `string` | `json` |  |  | 1/34 |
| `app_get_segment_clean_subdivision` | Get Segment Clean Subdivision | `string` | `json` |  |  | 1/34 |
| `app_get_tidy_up_map` | Get Tidy-Up Record Map | `number` | `value` | `0` |  | 1/34 |
| `app_get_tidy_up_zones` | Refresh Tidy-Up Zones | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_wifi_list` | Get Wi-Fi List | `boolean` | `button` | `false` |  | 1/34 |
| `app_get_zoned_clean_subdivision` | Get Zoned Clean Subdivision | `string` | `json` |  |  | 1/34 |
| `app_tidy_up_record_detail` | Get Tidy-Up Record | `number` | `value` | `0` |  | 1/34 |
| `app_tidy_up_record_summary` | Refresh Tidy-Up Summary | `boolean` | `button` | `false` |  | 1/34 |
| `check_homesec_password` | Check Home Security Password | `string` | `text` | `""` |  | 1/34 |
| `get_ap_mic_led_status` | Get Voice Control LED Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_auto_delivery_cleaning_fluid` | Get Auto Delivery Clean Fluid | `boolean` | `button` | `false` |  | 1/34 |
| `get_camera_status` | Get Camera Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_child_lock_status` | Get Child Lock Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_clean_roller_debug_info` | Get Clean Roller Debug Info | `boolean` | `button` | `false` |  | 1/34 |
| `get_collision_avoid_status` | Get Collision Avoid Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_dock_info` | Get Dock Info | `boolean` | `button` | `false` |  | 1/34 |
| `get_flow_led_status` | Get Flow LED Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_handle_leak_water_status` | Get Water Leak Check | `boolean` | `button` | `false` |  | 1/34 |
| `get_homesec_connect_status` | Get Home Security Connect Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_map_beautification_status` | Get Map Beautification Status | `boolean` | `button` | `false` |  | 1/34 |
| `get_smart_wash_params` | Get Smart Wash Params | `boolean` | `button` | `false` |  | 1/34 |
| `get_voice_history` | Get Voice History | `number` | `value` | `0` |  | 1/34 |
| `get_voice_history_summary` | Get Voice History Summary | `boolean` | `button` | `false` |  | 1/34 |
| `get_voice_service_switch` | Get Voice Service Switch | `boolean` | `button` | `false` |  | 1/34 |
| `get_wash_debug_params` | Get Wash Debug Params | `boolean` | `button` | `false` |  | 1/34 |
| `get_wash_towel_mode` | Get Wash Towel Mode | `boolean` | `button` | `false` |  | 1/34 |
| `get_wash_towel_params` | Get Wash Towel Params | `boolean` | `button` | `false` |  | 1/34 |
| `get_wash_water_temperature` | Get Wash Water Temperature | `boolean` | `button` | `false` |  | 1/34 |
| `test_get_enable_wakeup` | Get Voice Wakeup Status | `boolean` | `button` | `false` |  | 1/34 |
| `test_get_voice_keep_seconds` | Get Voice Keep Seconds | `boolean` | `button` | `false` |  | 1/34 |
| `test_get_voice_list` | Get Voice List | `boolean` | `button` | `false` |  | 1/34 |

#### `settings`

Beschreibbare Objekte in `Devices.<duid>.settings`.

| Objekt | Name | Typ | Rolle | Vorgabe | Werte / Bereich | Modelle |
| --- | --- | --- | --- | --- | --- | --- |
| `app_set_beautify_blocks` | Set Beautify Blocks | `string` | `json` |  |  | 1/34 |
| `app_set_carpet_deep_clean_status` | Set Carpet Deep Clean Status | `string` | `json` |  |  | 1/34 |
| `app_set_cross_carpet_cleaning_status` | Cross Carpet Cleaning | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `app_set_door_sill_blocks` | Set Door Sill Blocks | `string` | `json` |  |  | 1/34 |
| `app_set_dryer_setting` | Set Dryer Setting | `string` | `json` |  |  | 1/34 |
| `app_set_dryer_status` | Dryer Status | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `app_set_priority_carpet_cleaning_status` | Priority Carpet Cleaning | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `app_set_robot_setting` | Set Robot Setting | `string` | `json` |  |  | 1/34 |
| `app_set_smart_door_sill` | Set Smart Door Sill | `string` | `json` |  |  | 1/34 |
| `app_set_tidy_up_zones` | Set Tidy-Up Zones | `string` | `json` |  |  | 1/34 |
| `app_update_unsave_map` | Update Unsave Map | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `enable_homesec_voice` | Enable Home Security Voice | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `reset_homesec_password` | Reset Home Security Password | `boolean` | `button` | `false` |  | 1/34 |
| `set_ap_mic_led_status` | Voice Control LED | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_auto_delivery_cleaning_fluid` | Auto Delivery Clean Fluid | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_back_wash_interval` | Set Back Wash Interval | `number` | `value` | `20` | 10 … 50 [min] | 1/34 |
| `set_back_wash_mode` | Set Back Wash Mode | `number` | `value` | `0` | `0` = Smart<br>`1` = Custom<br>`2` = New Smart | 1/34 |
| `set_camera_status` | Set Camera Status Bitfield | `number` | `value` | `0` |  | 1/34 |
| `set_child_lock_status` | Child Lock | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_collision_avoid_status` | Collision Avoid Status | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_drying_time` | Set Drying Time | `number` | `value` | `0` |  | 1/34 |
| `set_flow_led_status` | Flow LED Status | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_handle_leak_water_status` | Water Leak Check | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_homesec_password` | Set Home Security Password | `string` | `json` |  |  | 1/34 |
| `set_ignore_carpet_zone` | Set Ignore Carpet Zone | `string` | `json` |  |  | 1/34 |
| `set_ignore_identify_area` | Set Ignore Identify Area | `string` | `json` |  |  | 1/34 |
| `set_map_beautification_status` | Map Beautification Status | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_mopping_speed` | Set Mopping Speed | `number` | `value` | `0` |  | 1/34 |
| `set_roller_speed` | Set Roller Speed | `number` | `value` | `0` |  | 1/34 |
| `set_smart_wash_params` | Set Smart Wash Params | `string` | `json` |  |  | 1/34 |
| `set_voice_service_switch` | Voice Service Switch | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `set_wash_debug_params` | Set Wash Debug Params | `string` | `json` |  |  | 1/34 |
| `set_wash_interval` | Set Wash Interval | `number` | `value` | `0` |  | 1/34 |
| `set_wash_towel_interval` | Set Wash Towel Interval | `number` | `value` | `0` |  | 1/34 |
| `set_wash_towel_mode` | Set Wash Towel Mode | `number` | `value` | `1` | `0` = Quick / Water Saving<br>`1` = Daily<br>`2` = Deep<br>`8` = Super Deep / Soak<br>`10` = Smart | 1/34 |
| `set_wash_towel_params` | Set Wash Towel Params | `string` | `json` |  |  | 1/34 |
| `set_wash_towel_status` | Set Wash Towel Status | `number` | `value` | `0` |  | 1/34 |
| `set_wash_water_temperature` | Set Wash Water Temperature | `number` | `value` | `0` | `0` = Normal<br>`1` = Warm<br>`2` = Hot / High Temperature | 1/34 |
| `switch_video_quality` | Switch Video Quality | `string` | `value` | `"SD"` | `SD` = SD<br>`HD` = HD<br>`FHD` = FHD<br>`AUTO` = AUTO | 1/34 |
| `test_set_enable_wakeup` | Voice Wakeup | `boolean` | `switch.enable` | `false` |  | 1/34 |
| `test_set_voice_keep_seconds` | Voice Keep Seconds | `number` | `value` | `0` |  | 1/34 |

#### `deviceStatus`

Vom Roboter gemeldete Werte in `Devices.<duid>.deviceStatus`.

| Objekt | Name | Typ | Einheit | Werte |
| --- | --- | --- | --- | --- |
| `adbumper_status` |  | `string` |  |  |
| `add_sweep_status` |  | `number` |  | `0` = None<br>`1` = Active |
| `along_floor` |  | `number` |  | `0` = Off<br>`1` = On |
| `assist_clean_status` | Assist Clean Status | `number` |  |  |
| `assistedTidyUp` | Assisted Tidy-Up | `number` |  | `0` = Off<br>`1` = On |
| `auto_dust_collection` |  | `number` |  |  |
| `autoGrabMode` | Auto Grab Mode | `boolean` |  |  |
| `avoid_count` |  | `number` |  |  |
| `back_type` |  | `number` |  | `1` = Washing Mop<br>`2` = Setting Up Mop<br>`3` = Removing Mop<br>`4` = Collecting Dust |
| `backTypeLabel` | Back Dock Substate | `string` |  |  |
| `battery` |  | `number` | `%` | [%] |
| `camera_status` |  | `number` |  |  |
| `cameraEnabled` | Camera Enabled | `boolean` |  |  |
| `canChangeCameraStatus` | Can Change Camera Status | `number` |  | `0` = No<br>`1` = Yes |
| `canPauseByToast` | Can Pause By Toast | `boolean` |  |  |
| `carpet_clean_mode` |  | `number` |  | `0` = Avoid<br>`1` = Rise<br>`2` = Ignore |
| `carpet_mode` |  | `string` |  | `[{"enable":0,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}]` = off<br>`[{"enable":1,"stall_time":10,"current_low":400,"current_high":500,"current_integral":450}]` = on |
| `charge_status` |  | `number` |  |  |
| `clean_area` |  | `number` | `m²` | [m²] |
| `clean_finish` |  | `string` |  |  |
| `clean_fluid` |  | `number` |  |  |
| `clean_mode_tab` |  | `number` |  | `0` = Vac & Mop<br>`1` = Mop<br>`2` = Vacuum<br>`3` = Custom<br>`4` = SmartPlan<br>`5` = General |
| `clean_percent` |  | `number` | `%` | [%] |
| `clean_tidyup_status` | Tidy-Up Status | `number` |  |  |
| `clean_time` |  | `number` | `min` | [min] |
| `clean_times` |  | `number` |  |  |
| `cleaned_area` |  | `number` | `m²` | [m²] |
| `cleaning_info` |  | `string` |  |  |
| `collision_avoid_status` |  | `number` |  |  |
| `common_status` |  | `number` |  |  |
| `corner_clean_mode` |  | `number` |  |  |
| `debug_mode` |  | `number` |  |  |
| `distance_off` | Distance Off | `number` |  |  |
| `dnd_enabled` |  | `number` |  |  |
| `dock_error_status` |  | `number` |  |  |
| `dock_type` | Dock Type | `number` |  | `0` = Charging dock<br>`1` = Auto-Empty Dock<br>`2` = Empty Wash Fill Dock<br>`3` = Empty Wash Fill (Dry) Dock<br>`5` = Auto-Empty Dock (Q8 Max+)<br>`6` = Empty Wash Fill Dry Dock (S8 Pro Ultra)<br>`7` = Empty Wash Fill Dry Dock (S8 Pro Ultra)<br>`8` = Empty Wash Fill Dry Dock (Q Revo)<br>`9` = Empty Wash Fill Dry Dock (Q Revo Pro)<br>`10` = Empty Wash Fill Dock (S7 MaxV Ultra)<br>`14` = Empty Wash Fill Dry Dock (Qrevo Master)<br>`15` = Empty Wash Fill Dry Dock (Qrevo S)<br>… (15) |
| `dockCanStopCollectDust` | Dock Can Stop Collect Dust | `boolean` |  |  |
| `dockCanStopWash` | Dock Can Stop Wash | `boolean` |  |  |
| `dry_status` |  | `number` |  |  |
| `dss` |  | `number` |  |  |
| `dtof_status` |  | `number` |  |  |
| `dust_bag_used` |  | `number` |  |  |
| `dust_collection_status` |  | `number` |  |  |
| `error_code` |  | `number` |  |  |
| `events` |  | `string` |  |  |
| `exit_dock` |  | `number` |  |  |
| `explorationEnabled` | Exploration Enabled | `boolean` |  |  |
| `extra_time` |  | `number` |  |  |
| `fan_power` |  | `number` |  | `101` = Quiet<br>`102` = Balanced<br>`103` = Turbo<br>`104` = Max<br>`105` = Gentle<br>`106` = Per-Room<br>`108` = Max+<br>`110` = SmartPlan |
| `green_laser` |  | `number` |  | `0` = Off<br>`1` = On |
| `hasCleanFluidModule` | Clean Fluid Module Installed | `boolean` |  |  |
| `hasDockError` | Dock Error Active | `boolean` |  |  |
| `hasMechanicalArmEmergencyError` | Mechanical Arm Emergency Error | `boolean` |  |  |
| `hasShownPetModeAlert` | Has Shown Pet Mode Alert | `boolean` |  |  |
| `home_sec_enable_password` |  | `number` |  | `0` = Disabled<br>`1` = Enabled |
| `home_sec_status` |  | `number` |  | `0` = Disconnected<br>`1` = Connected<br>`2` = Disconnecting |
| `homeSecClientId` | Home Security Client ID | `string` |  |  |
| `homeSecPasswordEnabled` | Home Security Password Enabled | `boolean` |  |  |
| `in_cleaning` |  | `number` |  | `0` = None<br>`1` = Global Clean<br>`2` = Zone Clean<br>`3` = Segment Clean<br>`4` = Quick Build Map |
| `in_fresh_state` |  | `number` |  |  |
| `in_returning` |  | `number` |  |  |
| `in_warmup` |  | `number` |  |  |
| `is_exploring` |  | `number` |  |  |
| `is_locating` |  | `number` |  |  |
| `isArmResetting` | Arm Resetting | `boolean` |  |  |
| `isAutoDeliveryOn` | Auto Delivery Active | `boolean` |  |  |
| `isBackDockTaskResumeable` | Back Dock Task Resumeable | `boolean` |  |  |
| `isBackDockWashingDusterMode` | Back Dock Washing Duster Mode | `boolean` |  |  |
| `isCleanCarouselSelfCleaning` | Dock Self-Cleaning Active | `boolean` |  |  |
| `isContinue` | Arm Continue | `boolean` |  |  |
| `isContinueToGrab` | Arm Continue To Grab | `boolean` |  |  |
| `isContinueToPutDown` | Arm Continue To Put Down | `boolean` |  |  |
| `isDrying` | Drying | `boolean` |  |  |
| `isEmergencyStopStatus` | Emergency Stop Active | `boolean` |  |  |
| `isEnteringDoor` | Arm Entering Door | `boolean` |  |  |
| `isExitingDock` | Exiting Dock | `boolean` |  |  |
| `isExitingDoor` | Arm Exiting Door | `boolean` |  |  |
| `isGrabing` | Arm Grabbing | `boolean` |  |  |
| `isGrabSucessful` | Grab Successful | `boolean` |  |  |
| `isHomeButtonsEnabled` | Home Buttons Enabled | `boolean` |  |  |
| `isHomeMapEditButtonsEnabled` | Home Map Edit Buttons Enabled | `boolean` |  |  |
| `isHomeModeControlButtonsEnabled` | Home Mode Control Buttons Enabled | `boolean` |  |  |
| `isHomeSecControlledByCurrentClient` | Home Security Controlled By Current Client | `boolean` |  |  |
| `isHomeSecDisconnected` | Home Security Disconnected | `boolean` |  |  |
| `isHomeSecDisconnecting` | Home Security Disconnecting | `boolean` |  |  |
| `isHomeSecFreeControl` | Home Security Free Control | `boolean` |  |  |
| `isHomeSecPreviewBlockedByOtherClient` | Home Security Preview Blocked By Other Client | `boolean` |  |  |
| `isHomeSecPreviewOwnedByCurrentClient` | Home Security Preview Owned By Current Client | `boolean` |  |  |
| `isHomeSecPreviewRetryPending` | Home Security Preview Retry Pending | `boolean` |  |  |
| `isHomeSecPreviewStartReady` | Home Security Preview Start Ready | `boolean` |  |  |
| `isHomeSecRunning` | Home Security Running | `boolean` |  |  |
| `isHomeSettingButtonEnabled` | Home Setting Button Enabled | `boolean` |  |  |
| `isInBackDockTask` | In Back Dock Task | `boolean` |  |  |
| `isLocked` | Locked | `boolean` |  |  |
| `isMechanicalModeChanging` | Mechanical Mode Changing | `boolean` |  |  |
| `isMechArmDoingMoveTask` | Mechanical Move Task Active | `boolean` |  |  |
| `isMechArmDoingTidyupTask` | Mechanical Tidy-Up Task Active | `boolean` |  |  |
| `isProgramMode` | Program Mode Active | `boolean` |  |  |
| `isPumpingWater` | Water Pumping Active | `boolean` |  |  |
| `isPuttingDown` | Arm Putting Down | `boolean` |  |  |
| `isReadyToCmd` | Ready To Command | `boolean` |  |  |
| `isSegmentCleaning` | Segment Cleaning | `boolean` |  |  |
| `isSettingCarpetCrossOn` | Cross-Carpet Cleaning Enabled | `boolean` |  |  |
| `isSettingCarpetFirstOn` | Carpet-First Cleaning Enabled | `boolean` |  |  |
| `isSettingDirtyReplenishOn` | Dirty-Replenish Cleaning Enabled | `boolean` |  |  |
| `isSpotCleaning` | Spot Cleaning | `boolean` |  |  |
| `isTidyUpHouseWork` | Tidy-Up Housework | `boolean` |  |  |
| `isVocieControlActive` | Voice Control Active | `boolean` |  |  |
| `isWaiting` | Arm Waiting | `boolean` |  |  |
| `isWashing` | Washing | `boolean` |  |  |
| `isWaterDraining` | Water Draining Active | `boolean` |  |  |
| `isZonedCleaning` | Zoned Cleaning | `boolean` |  |  |
| `kct` |  | `number` |  |  |
| `lab_status` |  | `number` |  |  |
| `last_clean_t` |  | `string` |  |  |
| `ledSetting` | Camera LED Setting | `number` |  |  |
| `lock_status` |  | `number` |  |  |
| `manualGrabMode` | Manual Grab Mode | `boolean` |  |  |
| `map_present` |  | `number` |  |  |
| `map_status` |  | `number` |  |  |
| `mapObjectPhotoEnabled` | Map Object Photo Enabled | `boolean` |  |  |
| `mapObjectPhotoPrivacyPolicyAgreed` | Map Object Photo Privacy Policy Agreed | `boolean` |  |  |
| `mechanicalArmActiveStatus` | Mechanical Arm Active Status | `number` |  | `0` = Inactive<br>`1` = Active |
| `mechanicalArmGrabMode` | Mechanical Arm Grab Mode | `number` |  | `0` = Off<br>`1` = Manual<br>`2` = Auto |
| `mechanicalArmGrabResult` | Mechanical Arm Grab Result | `number` |  | `0` = No Success<br>`1` = Success |
| `mechanicalArmGrabStatus` | Mechanical Arm Grab Status | `number` |  | `0` = Not Started<br>`1` = Exiting Door<br>`2` = Entering Door<br>`3` = Waiting<br>`4` = Grabbing<br>`5` = Putting Down<br>`7` = Continue<br>`8` = Mode Changing<br>`9` = Continue to Grab<br>`10` = Continue to Put Down |
| `mechanicalCameraEnabled` | Mechanical Camera Enabled | `boolean` |  |  |
| `mechanicalTidyUpHouseworkState` | Mechanical Tidy-Up Housework State | `number` |  | `0` = Idle<br>`1` = Active |
| `mechArmMoveObjectLabel` | Mechanical Move Object Label | `string` |  |  |
| `mechArmMoveObjectType` | Mechanical Move Object Type | `number` |  | `0` = None<br>`2` = Shoes<br>`34` = Fabrics / Sock<br>`51` = Clumps / Curled Fabric |
| `mechArmMoveTaskState` | Mechanical Move Task State | `number` |  | `0` = No Need<br>`1` = Need<br>`2` = To Tidy<br>`3` = Success<br>`4` = Not Found<br>`5` = User Handled<br>`6` = Shoes Unsupported<br>`7` = Object Unreachable<br>`8` = Object On Carpet<br>`9` = Object In Forbidden Zone<br>`10` = Object In Low Area<br>`11` = Object In Unsafe Area<br>… (22) |
| `mechArmTidyupObjectLabel` | Mechanical Tidy-Up Object Label | `string` |  |  |
| `mechArmTidyupObjectType` | Mechanical Tidy-Up Object Type | `number` |  | `0` = None<br>`2` = Shoes<br>`34` = Fabrics / Sock<br>`51` = Clumps / Curled Fabric |
| `mechArmTidyupTaskState` | Mechanical Tidy-Up Task State | `number` |  | `0` = No Need<br>`1` = Need<br>`2` = To Tidy<br>`3` = Success<br>`4` = Not Found<br>`5` = User Handled<br>`6` = Shoes Unsupported<br>`7` = Object Unreachable<br>`8` = Object On Carpet<br>`9` = Object In Forbidden Zone<br>`10` = Object In Low Area<br>`11` = Object In Unsafe Area<br>… (22) |
| `monitor_status` |  | `number` |  | `0` = Inactive<br>`1` = Active |
| `monitorActive` | Monitor Active | `boolean` |  |  |
| `monitorPrivacyPolicyAgreed` | Monitor Privacy Policy Agreed | `boolean` |  |  |
| `mop_forbidden_enable` |  | `number` |  |  |
| `mop_mode` |  | `number` |  | `300` = Standard<br>`301` = Deep<br>`302` = Per-Room<br>`303` = Deep+<br>`304` = Fast<br>`305` = Deep+<br>`306` = SmartPlan |
| `notInGrabMode` | Not In Grab Mode | `boolean` |  |  |
| `notStart` | Grab Not Started | `boolean` |  |  |
| `offlineMapEnabled` | Offline Map Enabled | `boolean` |  |  |
| `patrolActive` | Patrol Active | `boolean` |  |  |
| `patrolStatus` | Patrol Status | `number` |  |  |
| `petModeEnabled` | Pet Mode Enabled | `boolean` |  |  |
| `petSnapshotEnabled` | Pet Snapshot Enabled | `boolean` |  |  |
| `rdt` |  | `number` | `s` | [s] |
| `realTimeMonitorEnabled` | Real-Time Monitor Enabled | `boolean` |  |  |
| `realTimeVideoWithTwoKeysStatus` | Real-Time Video Two-Key Status | `number` |  | `0` = Off<br>`1` = Waiting Activation<br>`2` = Active |
| `realVideoSetting` | Real Video Setting | `number` |  | `0` = Lightly Disturb<br>`1` = Strong Reminder<br>`2` = Do Not Disturb |
| `repeat` |  | `number` |  |  |
| `replenish_mode` |  | `number` |  |  |
| `rss` |  | `number` |  |  |
| `rst` |  | `number` |  |  |
| `seq_type` |  | `number` |  |  |
| `state` |  | `number` |  |  |
| `status` |  | `number` |  | `1` = Start<br>`2` = Stop<br>`3` = Idle<br>`5` = Cleaning<br>`6` = Home<br>`7` = Manual<br>`8` = Charging<br>`9` = Charge Error<br>`10` = Pause<br>`11` = Spot<br>`12` = Error<br>`14` = Updating<br>… (22) |
| `sterilize_status` |  | `number` |  |  |
| `sub_error_code` | Sub Error Code | `number` |  |  |
| `subdivision_sets` |  | `number` |  |  |
| `switch_map_mode` |  | `number` |  |  |
| `switch_status` |  | `number` |  |  |
| `unsave_map_flag` |  | `number` |  |  |
| `unsave_map_reason` |  | `number` |  |  |
| `voice_chat_status` |  | `number` |  | `0` = Inactive<br>`1` = Active |
| `voiceChatActive` | Voice Chat Active | `boolean` |  |  |
| `wash_phase` |  | `number` |  | `11` = Running<br>`17` = Pumping |
| `wash_ready` |  | `number` |  |  |
| `wash_status` |  | `number` |  |  |
| `washingMode` | Washing Mode | `number` |  | `6` = Dock Self-Cleaning<br>`7` = Water Draining<br>`11` = Pumping Water |
| `washingModeLabel` | Washing Mode Label | `string` |  |  |
| `washingTaskStatus` | Washing Task Status | `number` |  |  |
| `washPhaseLabel` | Wash Phase | `string` |  |  |
| `water` |  | `number` |  | `200` = Off<br>`201` = Low<br>`202` = Medium<br>`203` = High<br>`204` = Per-Room |
| `water_box_carriage_status` |  | `number` |  |  |
| `water_box_mode` |  | `number` |  | `200` = Off<br>`201` = Low<br>`202` = Medium<br>`203` = High<br>`204` = Per-Room<br>`205` = Custom<br>`206` = Custom<br>`207` = Custom<br>`208` = Extreme<br>`209` = SmartPlan |
| `water_box_status` |  | `number` |  |  |
| `water_shortage_status` |  | `number` |  | `0` = Normal<br>`1` = Water Shortage |
| `waterShortageActive` | Water Shortage Active | `boolean` |  |  |
| `wind` |  | `number` |  | `101` = Quiet<br>`102` = Balanced<br>`103` = Turbo<br>`104` = Max<br>`105` = Gentle<br>`108` = Max+ |

#### `consumables`

Vom Roboter gemeldete Werte in `Devices.<duid>.consumables`.

| Objekt | Name | Typ | Einheit | Werte |
| --- | --- | --- | --- | --- |
| `cleaning_brush_work_times` |  | `number` | `cycles` | [cycles] |
| `dust_collection_work_times` |  | `number` | `cycles` | [cycles] |
| `filter_element_work_time` |  | `number` | `h` | [h] |
| `filter_life` |  | `number` | `%` | [%] |
| `filter_work_time` |  | `number` | `h` | [h] |
| `main_brush_life` |  | `number` | `%` | [%] |
| `main_brush_work_time` |  | `number` | `h` | [h] |
| `sensor_dirty_time` |  | `number` | `h` | [h] |
| `side_brush_life` |  | `number` | `%` | [%] |
| `side_brush_work_time` |  | `number` | `h` | [h] |
| `strainer_work_times` |  | `number` | `cycles` | [cycles] |

#### `cleaningInfo`

Vom Roboter gemeldete Werte in `Devices.<duid>.cleaningInfo`.

| Objekt | Name | Typ | Einheit | Werte |
| --- | --- | --- | --- | --- |
| `0` |  | `number` | `h` | [h] |
| `1` |  | `number` | `m²` | [m²] |
| `clean_area` |  | `number` | `m²` | [m²] |
| `clean_count` |  | `number` |  |  |
| `clean_time` |  | `number` | `h` | [h] |
| `dust_collection_count` |  | `number` |  |  |

#### `cleaningInfo.records.<index>`

Vom Roboter gemeldete Werte in `Devices.<duid>.cleaningInfo.records.<index>`.

| Objekt | Name | Typ | Einheit | Werte |
| --- | --- | --- | --- | --- |
| `0` |  | `string` |  |  |
| `1` |  | `string` |  |  |
| `2` |  | `number` | `min` | [min] |
| `3` |  | `number` | `m²` | [m²] |
| `4` |  | `number` |  |  |
| `5` |  | `number` |  |  |
| `6` |  | `number` |  |  |
| `7` |  | `number` |  |  |
| `8` |  | `number` |  |  |
| `9` |  | `number` |  |  |
| `area` |  | `number` | `m²` | [m²] |
| `avoid_count` |  | `number` |  |  |
| `begin` |  | `string` |  |  |
| `clean_times` |  | `number` |  |  |
| `clean_type` |  | `number` |  |  |
| `cleaned_area` |  | `number` | `m²` | [m²] |
| `complete` |  | `number` |  |  |
| `dirty_replenish` |  | `number` |  |  |
| `duration` |  | `number` | `min` | [min] |
| `dust_collection_status` |  | `number` |  |  |
| `end` |  | `string` |  |  |
| `error` |  | `number` |  |  |
| `extra_time` |  | `number` |  |  |
| `finish_reason` |  | `number` |  |  |
| `manual_replenish` |  | `number` |  |  |
| `map_flag` |  | `number` |  |  |
| `start_type` |  | `number` |  |  |
| `sub_source` |  | `number` |  |  |
| `task_id` |  | `number` |  |  |
| `wash_count` |  | `number` |  |  |

#### Zurücksetzbare Verbrauchsteile

Für diese Verbrauchsteile legt der Adapter unter `Devices.<duid>.resetConsumables` einen Knopf an, der den Zähler im Roboter zurücksetzt.

- `cleaning_brush_work_times`
- `dust_collection_work_times`
- `filter_element_work_time`
- `filter_work_time`
- `main_brush_work_time`
- `sensor_dirty_time`
- `side_brush_work_time`
- `strainer_work_times`

<!-- END:states -->

<!-- BEGIN:models -->

### Unterstützte Modelle

Der Adapter bringt 34 Modellprofile mit. Ein Roboter, dessen Modell-ID hier nicht steht, läuft mit einem allgemeinen Profil, allerdings ohne die modellspezifischen Befehle. "Befehlsobjekte" zählt die beschreibbaren Objekte, die das Profil anlegt, "Funktionen" die Fähigkeiten, die es statisch angibt (Station, Kamera, Moppwäsche und so weiter).

| Modell | Modell-ID | Protokoll | Befehlsobjekte | Funktionen |
| --- | --- | --- | --- | --- |
| Roborock S6 Pure (a08) | `roborock.vacuum.a08` | V1 | 31 | 2 |
| Roborock S6 MaxV (a10) | `roborock.vacuum.a10` | V1 | 31 | 6 |
| Roborock Q Revo Pro (a101) | `roborock.vacuum.a101` | V1 | 37 | 19 |
| Roborock Qrevo S (a104) | `roborock.vacuum.a104` | V1 | 31 | 14 |
| Roborock Qrevo Master (a117) | `roborock.vacuum.a117` | V1 | 36 | 22 |
| Roborock Qrevo Curv (a135) | `roborock.vacuum.a135` | V1 | 36 | 29 |
| Roborock Saros 10R (a144) | `roborock.vacuum.a144` | V1 | 36 | 23 |
| Roborock Saros 10 (a147) | `roborock.vacuum.a147` | V1 | 36 | 28 |
| Roborock S7 (a15) | `roborock.vacuum.a15` | V1 | 31 | 7 |
| Roborock Qrevo Edge (a156) | `roborock.vacuum.a156` | V1 | 36 | 22 |
| Roborock Qrevo Curv Series (a159) | `roborock.vacuum.a159` | V1 | 36 | 22 |
| Roborock Qrevo L (a168) | `roborock.vacuum.a168` | V1 | 36 | 22 |
| Roborock Saros Z70 (a179) | `roborock.vacuum.a179` | V1 | 177 | 28 |
| Roborock Qrevo Edge Series (a187) | `roborock.vacuum.a187` | V1 | 36 | 22 |
| Roborock S4 Max (a19) | `roborock.vacuum.a19` | V1 | 31 | 1 |
| Roborock Qrevo Slim (a21) | `roborock.vacuum.a21` | V1 | 36 | 22 |
| Roborock S7 MaxV (Pro/Ultra) (a27) | `roborock.vacuum.a27` | V1 | 36 | 24 |
| Roborock Saros 20 (a288) | `roborock.vacuum.a288` | V1 | 36 | 28 |
| Roborock Qrevo Edge 2 (a298) | `roborock.vacuum.a298` | V1 | 36 | 22 |
| Roborock Q7 Max (a38) | `roborock.vacuum.a38` | V1 | 31 | 7 |
| Roborock Q7 (a40) | `roborock.vacuum.a40` | V1 | 31 | 5 |
| Roborock S8 (a51) | `roborock.vacuum.a51` | V1 | 31 | 14 |
| Roborock S7 Pro Ultra (a62) | `roborock.vacuum.a62` | V1 | 31 | 10 |
| Roborock S7 Max Ultra (a65) | `roborock.vacuum.a65` | V1 | 31 | 13 |
| Roborock S8 Pro Ultra (a70) | `roborock.vacuum.a70` | V1 | 36 | 20 |
| Roborock Q5 Pro (a72) | `roborock.vacuum.a72` | V1 | 31 | 14 |
| Roborock Q8 Max (a73) | `roborock.vacuum.a73` | V1 | 31 | 14 |
| Roborock Q Revo (a75) | `roborock.vacuum.a75` | V1 | 31 | 17 |
| Roborock Qrevo MaxV (a87) | `roborock.vacuum.a87` | V1 | 32 | 23 |
| Roborock S8 MaxV Ultra (a97) | `roborock.vacuum.a97` | V1 | 36 | 28 |
| Roborock S4 | `roborock.vacuum.s4` | V1 | 31 | 0 |
| Roborock S5 Max | `roborock.vacuum.s5e` | V1 | 31 | 3 |
| Roborock S6 | `roborock.vacuum.s6` | V1 | 31 | 3 |
| roborock.vacuum.sc01 | `roborock.vacuum.sc01` | B01 | 16 | 0 |

<!-- END:models -->

## FAQ

**Die Instanz bleibt gelb und das Log fragt nach einem Login-Code.**
Es ist die Anmeldemethode *E-Mail + 2FA-Code* aktiv. Roborock hat einen sechsstelligen
Code an die Konto-E-Mail-Adresse geschickt. Diesen innerhalb von 15 Minuten nach dem
Instanzstart in `roborock.<instanz>.loginCode` schreiben; im Konfigurationsdialog gibt es
kein Eingabefeld dafür.

**Es wird kein Roboter gefunden, obwohl er im selben Netz hängt.**
Der Adapter hört auf UDP-Port 58866 auf Geräte-Broadcasts. Manche Netze filtern diese
(VLANs, WLAN-Client-Isolation, LXC- oder Docker-Bridges). Entweder dem Roboter in der
manuellen Gerätekonfiguration eine feste IP-Adresse geben oder unter
**Netzwerkschnittstelle für die Suche** die richtige Schnittstelle auswählen.

**Die Karte bleibt leer.**
Die Kartenerzeugung muss auf dem Reiter *Karte* eingeschaltet sein, und die Karte braucht
derzeit die Cloud-Verbindung. Im Modus *Nur lokal* wird keine Karte abgerufen.

**Ein Befehlsobjekt existiert, aber der Roboter reagiert nicht.**
Nicht jeder Befehl wird von jedem Modell unterstützt. Die
[States-Referenz](#states-referenz) nennt zu jedem Objekt, wie viele der Modellprofile es
anbieten. Ist das Objekt vorhanden und der Roboter ignoriert es trotzdem, setzt die
Firmware genau dieses Modells den Befehl möglicherweise nicht um.

**Wo sehe ich, warum der Roboter stehen geblieben ist?**
`deviceStatus.error_code` trägt den numerischen Grund, `deviceStatus.state` die aktuelle
Tätigkeit. Die Bedeutung aller Fehlercodes steht unten.

<!-- BEGIN:errors -->

### Fehlercodes

Werte von `deviceStatus.error_code`. Den aufgelösten Text veröffentlicht der Adapter zusätzlich in der Werteliste von `deviceStatus.error_code`.

<details>
<summary>Fehlercodes (137)</summary>

| Code | Bedeutung |
| --- | --- |
| `-1` | Unknown Error |
| `0` | No error |
| `1` | LiDAR Sensor error |
| `2` | Bumper stuck |
| `3` | Wheels suspended |
| `4` | Cliff sensor error |
| `5` | Main brush jammed. |
| `6` | Side brush jammed. |
| `7` | The robot is stuck, or main wheels are jammed. |
| `8` | The robot is trapped or stuck. |
| `9` | Dustbin not installed |
| `10` | Filter is blocked. |
| `11` | Strong magnetic field detected. |
| `12` | Low battery |
| `13` | Charging Error |
| `14` | Unit temperature protection |
| `15` | The wall sensor is dirty. |
| `16` | Robot is tilted |
| `17` | Side brush error |
| `18` | Fan error |
| `19` | Dock not connected to power |
| `21` | Vertical Bumper Error |
| `22` | Recharge Sensor Error |
| `23` | Could not Reach Dock |
| `24` | No-Go Zone or Invisible Wall detected |
| `25` | Camera Error |
| `26` | Wall sensor error |
| `27` | Jammed mop module |
| `28` | The robot may be on a carpet |
| `29` | Suspected pet waste found. |
| `30` | ImageFPSError |
| `31` | Front and Rear Sensors Error |
| `32` | No dustbin or filter installed |
| `33` | Auto-Empty Dock fan error |
| `34` | Clean the Auto-Empty Dock bin |
| `35` | Auto-Empty Dock voltage error |
| `36` | Wash roller may be jammed. |
| `37` | Wash roller not lowered properly. |
| `38` | Check the clean water tank. |
| `39` | Check the dirty water tank. |
| `40` | Water filter not installed. |
| `41` | Clean water tank empty. |
| `42` | Check that the water filter has been correctly installed. |
| `43` | Positioning button Error |
| `44` | Check and secure the dirty water tank cover |
| `45` | Wash roller may be jammed. |
| `48` | Refill error |
| `49` | Drain error |
| `51` | Unit temperature protection |
| `52` | Please check the cleaning tray. |
| `53` | Cleaning tray full. |
| `54` | The mop mount fell off. |
| `56` | ### |
| `57` | Cleaning tank maintenance brush error |
| `59` | ### |
| `60` | ### |
| `61` | 请检查激光雷达升降模组 |
| `62` | 请检查清洗槽滤网 |
| `64` | 机械手压力开关触发 |
| `65` | 机械手边缘防夹传感器触发 |
| `66` | 舱门开关失败 |
| `67` | 机械手卡住 |
| `68` | 机械手过流 |
| `69` | 机械手状态异常 |
| `70` | 机械手温度异常 |
| `71` | 机械手被困住 |
| `74` | 顶面感知传感器可能脏污 |
| `76` | 滚筒未安装 |
| `77` | 导水槽未安装 |
| `78` | 污水盒未安装 |
| `79` | 滚筒掉落 |
| `80` | 导水槽掉落 |
| `81` | 污水盒掉落 |
| `82` | 滚筒罩异常 |
| `83` | 基站顶出机构异常 |
| `84` | 主机污水盒排水异常 |
| `85` | 拖布支架未安装 |
| `86` | 支撑臂可能卡入异物 |
| `95` | Mop cloth mount installation failed |
| `97` | 清洁液余量低 |
| `100` | Unknown |
| `101` | Compass error |
| `102` | Right compass error |
| `103` | Main brush short circuit |
| `104` | Main brush open circuit |
| `105` | Left wheel short circuit |
| `106` | Left wheel open circuit |
| `107` | Right wheel short circuit |
| `108` | Right wheel open circuit. |
| `109` | Fan open circuit |
| `110` | Motion tracking sensor init error |
| `111` | Gyroscope init error |
| `112` | Charging IC error |
| `113` | NVRAM error |
| `114` | WiFi module error 1 |
| `115` | WiFi module error 2 |
| `116` | ODO error |
| `117` | Left ODO error |
| `118` | Right ODO error |
| `119` | Audio init error |
| `120` | Wall sensor init error |
| `121` | Wall sensor error |
| `122` | Wall sensor error |
| `123` | Camera Exception |
| `124` | Camera Exception |
| `125` | Peristaltic pump abnormality |
| `126` | Dock Fan Error |
| `127` | Dock IIC Error |
| `128` | Mopping module short-circuited. |
| `129` | Mopping module motor circuit breaker |
| `130` | No data from clean water tank peristaltic pump ODO |
| `131` | Over-current of clean water tank peristaltic pump |
| `134` | Air pump switch error |
| `135` | Wash roller locked rotor |
| `137` | Wash roller motor temperature too high |
| `138` | Main brush locked rotor |
| `140` | Main brush motor temperature too high |
| `141` | Left wheel motor temperature too high |
| `143` | Right wheel motor temperature too high |
| `145` | Dirty water pump error |
| `147` | Maintenance brush positioning error - left |
| `148` | Maintenance brush positioning error - middle |
| `149` | Maintenance brush positioning error - right |
| `150` | Solenoid valve error |
| `151` | Drying fan error |
| `152` | Fill&Drain-discharge pump error |
| `153` | Fill&Drain-water inlet electronic valve/clean water level Hall sensor error |
| `154` | Side brush error |
| `155` | Fan error |
| `156` | Dock ODD Error |
| `157` | Dock Error |
| `158` | Fill&Drain- dirty water level Hall sensor error |
| `159` | Fill&Drain-communication error |
| `253` | Right compass error |
| `254` | Bin full |
| `255` | Internal error |
| `644` | Empty the dustbin |

</details>

<!-- END:errors -->

## Hilfe

Fehler und Fragen gehören in den
[GitHub-Issue-Tracker](https://github.com/copystring/ioBroker.roborock/issues).
Bitte die Adapterversion, die Modell-ID des Roboters und den passenden Teil des Logs mit
Loglevel `debug` angeben.

## Lizenz

MIT - siehe die Datei [LICENSE](../../LICENSE) des Repositorys.
