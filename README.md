![Logo](admin/roborock.png)
# ioBroker.roborock

[![NPM version](https://img.shields.io/npm/v/iobroker.roborock.svg)](https://www.npmjs.com/package/iobroker.roborock)
[![Downloads](https://img.shields.io/npm/dm/iobroker.roborock.svg)](https://www.npmjs.com/package/iobroker.roborock)
![Number of Installations](https://iobroker.live/badges/roborock-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/roborock-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.roborock.png?downloads=true)](https://nodei.co/npm/iobroker.roborock/)

**Tests:** ![Test and Release](https://github.com/copystring/ioBroker.roborock/workflows/Test%20and%20Release/badge.svg)

**Translation:** [![Translation status](https://weblate.iobroker.net/widgets/adapters/-/roborock/svg-badge.svg)](https://weblate.iobroker.net/engage/adapters/?utm_source=widget)

## Roborock adapter for ioBroker

This adapter allows you the control, get states, cleaning history and view the map of a Roborock vacuum cleaner which is set up in the Roborock app.

## Documentation

- [English documentation](./docs/en/README.md)
- [Deutsche Dokumentation](./docs/de/README.md)

The setup instructions, the configuration reference and the complete states reference live there. The reference tables are generated from the source code with `npm run docs`.

- [Requirements](#requirements)
- [Supported robots](#supported-robots)
- [Zone cleaning](#zone-cleaning)
- [Changelog](#changelog)
- [License](#license)

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** For more details and for information how to disable the error reporting see [Sentry-Plugin Documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry)! Sentry reporting is used starting with js-controller 3.0.

## Requirements

- Node.js >= 22.0.0
- ioBroker.admin >= 7.6.17
- ioBroker.js-controller >= 6.0.11

## Supported robots

- **S-Series:** S4, S4 Max, S5 Max, S6, S6 Pure, S6 MaxV, S7, S7 MaxV (Pro/Ultra), S7 Pro Ultra, S7 Max Ultra, S8, S8+, S8 Pro Ultra, S8 MaxV Ultra
- **Q-Series:** Q5 Pro, Q7, Q7 Max, Q7 L5, Q8 Max
- **Q Revo:** Q Revo, Q Revo Pro
- **Qrevo:** Qrevo Slim, Qrevo S, Qrevo Curve, Qrevo Curv Series, Qrevo Edge, Qrevo Edge Series, Qrevo L, Qrevo Master, Qrevo MaxV
- **Saros:** Saros 10, Saros 10R, Saros 20 / Saros 20X, Saros Z70

## Zone cleaning
This feature only works when map creation is enabled in the adapter options. Open the map from the adapter’s web UI tab in the ioBroker admin interface; no manual URL needed.

### Map creation does not work on raspberry pi
- Draw your square meant for cleaning. Roborock supports up to 4 cleaning zones at once.

 ![](https://github.com/copystring/ioBroker.roborock/blob/main/images/Rockrock_zone_cleaning.gif)

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

- (Eistee82) Corrected the suction level `fan_power` 105. The adapter called it "Off"; the robot's own app calls it "Gentle" and lists it as the first of the suction levels, not as switching suction off. The value itself is unchanged, only its label - existing states show the new text after the adapter has updated the object once.
- (Eistee82) Fixed the water levels `water_box_mode` 208 and 209, which the adapter labelled "Custom" along with everything from 205 upwards. 208 is the maximum water amount ("Extreme"), 209 means the robot lets SmartPlan decide, and the one value that really is the user-defined amount is 207. 205 and 206 do not appear in the app at all and keep the label they had.
- (Eistee82) The water levels are now worded the way the robot's own app words them for that robot. Devices with a vibrating mop module (SonicMop, e.g. the S7 Max Ultra family) show Mild / Standard / Intense, all others Low / Medium / High. Until now every device got a mixture of the two, including "Moderate", which the app uses nowhere. Which of the two applies is not something a robot reports - it is a model table inside the app - so the adapter derives it from the model string, exactly as the map tab already does for the matching icons, and an unknown model keeps the standard wording.
- (Eistee82) Devices with a vibrating mop module also offer the water level "Extreme" (208) again. The app additionally requires a firmware bit for it that is not known while the states are being built; a robot without it simply rejects the value, whereas leaving the level out hid it from every robot that has it.
- (Eistee82) Documented the mode values that are not selectable levels: `fan_power` 106 / 110, `mop_mode` 302 / 306 and `water_box_mode` 204 / 209 mean "this room has its own setting" or "SmartPlan decides". They now render as "Per-Room" and "SmartPlan" when the robot reports them instead of showing a bare number, and they are deliberately not offered for selection. `mop_mode` 305 was missing entirely and shares its label "Deep+" with 303, the way the app does.
- (Eistee82) `in_cleaning` shows what kind of run could be resumed (Zone Clean, Segment Clean, ...) instead of a bare number. A second, independent source confirmed the reading the adapter already used.
- (Eistee82) The poll cadence while the robot is working is configurable again. Adaptive polling had fixed it at 5 seconds, down from the former 2, with no way to change it. "Advanced" now holds "Update interval while cleaning" (2-60 s, default 5) next to a "Maximum wait after failed polls" (30-900 s, default 300) that decides how quickly a robot that went unreachable is picked up again. Both help texts name the price of a low value: more network traffic and more load on the robot and on ioBroker. The existing idle interval finally has a help text too. The start-up floor of 30 s stays internal - it only applies while the adapter boots or a map is loading, so a slider for it would buy nothing. Out-of-range values from a hand-edited instance config are clamped rather than obeyed.
- (Eistee82) Removed the `floors.cleanCount` state. Nothing in the adapter ever read it: the repeat count that is actually sent comes from `commands.set_clean_repeat_times`, falling back to `deviceStatus.repeat`, and the firmware accepts only 1 or 2 passes. The orphan suggested both a per-floor scope and an unbounded value range, neither of which exists. It is no longer created, and an existing one is deleted once at start-up, the same way the legacy `deviceInfo.localKey` state is cleaned up.

- (Eistee82) The cleaning order can now be set. `commands.set_clean_sequence` takes the ordered list of segment IDs as JSON, for example `[16,18,17]`; an empty list `[]` clears the order and lets the robot work one out for itself, the same wording its own app uses. Firmware that announces the retry envelope (bit 26 of `new_feature_info`) gets the payload wrapped as `{data, need_retry}` and the deferred result is polled with `retry_request` until the robot confirms it, so the call no longer just hangs.

- (Eistee82) Fixed the water level icons on devices with a vibrating mop. The app keeps two artwork families side by side and picks between them from a model table compiled into its control plugin; the tab now derives the same choice from the model string. Devices such as the S7 MaxV Ultra family previously showed the icons of the other family.

- (Eistee82) The suction, mop and water selectors in the map tab now show the Roborock app's own icons next to each mode. The artwork is not shipped with the adapter: it is the device control plugin the adapter already downloads into the file storage for each user's own account, so nothing is redistributed. The value-to-icon assignment is read out of that plugin rather than guessed - the file names do not follow the mode numbers, `clean0` is Gentle and not Quiet - and any value whose icon is not backed by such a finding stays plain text, because a wrong icon would show a suction level the user did not pick. Mop route Custom, suction Custom and Smart, and the legacy suction values have no icon in the plugin and therefore none here.
- (Eistee82) The mode icons follow the admin's light/dark choice and switch over the moment the theme changes, without reloading the tab. An installation that never ran against a cloud account has no artwork at all; every icon is verified before it is placed, so a missing file leaves the plain mode name instead of a broken image.
- (Eistee82) Fixed the map tab flashing a white page in a dark admin while the socket connects, and handed the colour scheme to the browser so the scrollbars it draws itself turn dark with the rest.

- (Eistee82) The dock panel now offers only the half of each Start/Stop pair that applies: while the station washes the mop or empties the dust container the robot reports it, so mop washing and dust collection show their Stop button instead of both at once.

- (Eistee82) Fixed the obstacle icons in the map tab showing a broken image placeholder. The artwork lives in the adapter file storage, which the admin serves under a different path than the former web adapter did; the tab now resolves it relative to the admin root so it also survives a reverse proxy.
- (Eistee82) Fixed the pass selector in the map tab cutting off its label. It had a fixed width that was too narrow for the longest translation and was additionally squeezed by the surrounding row.
- (Eistee82) Removed the grid texture behind the floating surfaces of the map tab. The surfaces keep their rounding, shadow and translucency; only the pattern is gone, together with its CSS rule and its `--rr-grid` variable.
- (Eistee82) The consumable reset in the map tab is an icon button with a tooltip instead of a wide caption, so a panel of six parts stays as narrow as the panel itself. Its inline confirmation is unchanged and still uses labelled buttons - an accidental reset falsifies the maintenance planning for good.
- (Eistee82) The run controls of the map tab now follow the reported robot state instead of showing Start and Stop side by side, where one of them was always meaningless. Cleaning offers Pause and Stop, a paused robot offers Resume and Stop, one on its way back offers only Stop, and one in its station only Start. A state the table does not know still offers Start, because an empty control bar is worse than one button too many. The station panel disables the wash, dry and dust actions while the robot is away from its dock and says so in the tooltip.
- (Eistee82) The device state in the map tab is translated. The adapter publishes the `common.states` of `deviceStatus.state` in English, so a German admin read "Charging"; the tab now resolves the reported code through 38 new `ui_state_*` keys in all eleven languages and falls back to the object's own text for a code it does not know.
- (Eistee82) Fixed the room names in the map tab being unreadably small. They counter-scale against the map zoom, which cancelled the drawn font size exactly and pinned every name to 12 screen pixels regardless of zoom or display. The counter-scale stays - it is what keeps the names steady - but it now resolves to a size derived from the map's real viewport and `devicePixelRatio`, clamped in screen pixels between 14 and 26, which is about 17 px in a normal tab and around 20 px in a large window.

- (Eistee82) Added the missing user documentation `docs/en/README.md` and `docs/de/README.md` with setup instructions (including the cloud free operation with `duid`/`localKey`), a configuration reference, a states reference and an FAQ.
- (Eistee82) The reference tables of that documentation are generated instead of hand maintained: the model, command and state tables come from the real feature handlers, which are instantiated offline through the model registry, and the configuration tables come from `admin/jsonConfig.json` together with the existing `admin/i18n` translations. Only the parts between the `BEGIN`/`END` marker comments belong to the generator; the prose around them is never touched.
- (Eistee82) Added a unit test that fails as soon as the generated documentation sections no longer match the code or the admin configuration, so the documentation cannot go stale unnoticed. `npm run docs -- --check` reports the same without writing anything.
- (Eistee82) Fixed `npm run docs` deleting hand maintained documents: the cleanup step removed every markdown file below `docs/`, which silently dropped `docs/map/Q10_B01_Map_Pipeline.md` on every run. The generator now only deletes files that carry its own generated marker.
- (Eistee82) The map UI is now a React admin tab instead of a standalone page served by the web adapter. It is built with Vite into `admin/tab.html` and `admin/assets/`, and its `App` extends `GenericApp` from `@iobroker/adapter-react-v5`, so socket, theme, language and instance come from the admin. The new sources live in `src-tab/`.
- (Eistee82) Fixed the map page reloading itself endlessly and therefore appearing not to load at all. The removed `src/www/conn.ts` opened a second socket.io connection and reloaded the page whenever authentication did not answer within three seconds. The tab now uses the admin connection, which has no such timer.
- (Eistee82) Removed the `web` dependency. The map page used to be served by the web adapter from `www/`; the admin now serves the tab itself, so `common.adminTab.link` and `common.localLinks` are gone and `adminTab` is marked `singleton`.
- (Eistee82) Redesigned the map UI along the Roborock app: the map fills the whole tab and the controls float above it instead of sitting in a side column. The palette comes from the app's own map assets (ground blue `#a9c9f0`, turquoise `#2ec4c0`, accent `#2d9cdb`), the fine grid of the app's map themes is reused as a quiet texture behind the floating surfaces, and all figures use `tabular-nums` so battery and area no longer jump while updating. The palette is applied as a MUI theme on top of the admin theme, so light and dark keep working.
- (Eistee82) Removed `src/www/` and `www/` together with the `build:www` esbuild step. The map drawing itself (D3, `drawMapV1`, `SVGMapRenderer`) was carried over unchanged into `src-tab/src/engine/`; only its edges changed, so the adapter side in `src/lib/socketHandler.ts` stayed untouched.
- (Eistee82) Fixed the schedule switch `schedules.<timerId>.enabled` having no effect: writes were never subscribed and were silently dropped. Toggling it now sends `upd_timer` to the robot, and the switch is only acknowledged after the robot confirmed the change.
- (Eistee82) Fixed the "Load Map" button `floors.<mapFlag>.load` having no effect: like the schedule switch it was never subscribed, so pressing it never reached the floor switch logic.
- (Eistee82) The `deviceStatus` entries `along_floor`, `green_laser`, `status`, `wind` and `water` are no longer marked writable. They only mirror what the robot reports; the working write surface is the `commands` folder.
- (Eistee82) Fixed room switches being collected across all stored maps when starting a segment cleaning: only the rooms of the currently loaded map are sent to `app_segment_clean`. On devices with several floors this previously mixed rooms of different floors into one cleaning job, because room ids are only unique within one map.
- (Eistee82) Added room cleaning to the map web UI: room names in the map are now clickable, several rooms can be selected at once and started with one button. The adapter already supported this; only the UI and the `app_segment_clean` bridge were missing.
- (Eistee82) Added a floor selector to the map web UI. It is filled from the `load_multi_map` command object and switches the stored map via the new `load_multi_map` socket command.
- (Eistee82) Added a status line above the map showing robot state, battery, cleaned area, cleaning duration, error text and, where available, the preferred connection channel.
- (Eistee82) Added suction, mop and water selectors to the map web UI. Their options come from the `common.states` of the command objects, so the UI needs no knowledge about device models.
- (Eistee82) The map web UI no longer guesses the robot state: Start/Pause now follow `deviceStatus.state` (`deviceStatus.status` on B01/Q10), so a run started from the phone app is shown correctly.
- (Eistee82) Added the generic `set_state` socket command for the web UI. It only writes to command folders the device handler registered, which keeps the web UI from writing arbitrary states.
- (Eistee82) The map web UI is now localized in all eleven adapter languages and no longer has a fixed 450 x 450 pixel layout; the map fills the available space and the controls wrap below it on narrow screens.
- (Eistee82) The map web UI now shows a hint while it waits for map data and reports failed commands in the page instead of only in the browser console.
- (Eistee82) Fixed the zone repeat selector in the map web UI offering three passes while the adapter command `set_clean_repeat_times` only allows two.
- (Eistee82) Added a collapsible consumables panel to the map web UI. It groups every published value per part, shows the remaining lifetime as a bar wherever the object definition declares a range, flags parts that are due, and offers a per part reset behind an inline confirmation instead of a browser dialog.
- (Eistee82) Added the `reset_consumable` socket command for the web UI. Like `set_state` it is a security boundary of its own: only a writable boolean button the adapter itself published below `resetConsumables` can be triggered, and the written value is always `true`.
- (Eistee82) Added a collapsible dock panel to the map web UI showing mop wash, mop drying, dust collection, station cleaning modes and the station states. Which entries appear is derived from the published command objects and states, so a device without a dock shows no panel at all instead of an empty one, and a dock fault is flagged on the collapsed panel header.
- (Eistee82) Removed the ineffective `importmap` from the map page; d3 is compiled into `www/app.js` and was never loaded from the internet.
- (Eistee82) Fixed room names on devices with several stored maps: rooms are now consistently keyed by the composite `(mapFlag, roomId)`, so maps that reuse the same room ids no longer show the names of another floor.
- (Eistee82) The generated V1 map data now carries the active `mapFlag`, and the map web UI requests and caches room names per floor instead of always using floor 0.
- (Eistee82) Added method dependent request timeouts: status polls now fail fast while map, photo and cleaning commands get the time they actually need. All values live in one declarative table (`src/lib/requestPolicy.ts`).
- (Eistee82) Added adaptive polling: slower while the robot is idle or the adapter is still starting up, faster while it is cleaning, with exponential backoff per device after failed polls.
- (Eistee82) Replaced the flat one second retry delay with exponential backoff and jitter.
- (Eistee82) Fixed the timeout cascade after a connection loss: pending and new requests now fail immediately with a clear message instead of each running into its own timeout, and repeated outage messages are throttled to one per device per minute.
- (Eistee82) Fixed an explicit request timeout being silently overwritten for any method containing "map" (the floor switch asked for 60s and got 20s).
- (Eistee82) Fixed the 24h request ID reset interval and the request bookkeeping timers not being cleared when the adapter unloads.
- (Eistee82) Added manual device configuration: `duid` + `localKey` (optionally static IP and protocol version) can be entered directly, so the adapter works without ever asking for Roborock cloud credentials. The local key is stored encrypted and is never written to the log.
- (Eistee82) Added the enforceable connection mode "local only". In this mode the adapter never contacts the Roborock cloud, and functions that would need it fail with a clear message instead of silently falling back. Map retrieval currently still needs the cloud connection; the configuration page says so.
- (Eistee82) Added per device connection states `connection.local`, `connection.cloud`, `connection.preferred` and `connection.ip` so the active transport channel is visible.
- (Eistee82) Made the network binding explicit: the UDP 58866 discovery socket can be bound to a selectable network interface, and discovery can be switched off entirely when static IP addresses are configured. This addresses the recurring LXC/multi-NIC problems.
- (Eistee82) Added a "Search devices in network" button to the configuration page that reports `duid`, IP address and protocol version of devices broadcasting on the local network.
- (Eistee82) Changed the MQTT client ID to `mqttUser_<random>` so the adapter and the Roborock phone app no longer disconnect each other when using the same account.
- (Eistee82) Stopped exposing the device `localKey` as a state under `deviceInfo` and removed the legacy state on startup.
- (Eistee82) Grouped the adapter configuration into the tabs "Account & connection", "Map" and "Advanced" and documented where the 2FA login code has to be entered.

### 0.7.4 (2026-06-07)

* (copystring) Documented tested Roborock S8+ support.
* (copystring) Fixed consumable percentage values for devices where Roborock reports maintenance data via HomeData.
* (copystring) Re-enabled macOS support and added macOS test coverage.
* (copystring) Improved dependency update automation so updates are checked weekly and merged only after successful checks.
* (copystring) Updated `p-queue` to 9.3.0 and `protobufjs` to 8.5.0.
* (copystring) Improved CI performance for Linux, macOS and Windows adapter tests without reducing test coverage.

### 0.7.3 (2026-05-22)

* (copystring) Fixed V1 auto-empty dust collection to use the AppPlugin-verified `app_start_collect_dust` command.

### 0.7.2 (2026-05-20)

* (copystring) Fixed missing auto-empty command for Roborock Qrevo MaxV (#1272).
* (copystring) Fixed local endpoint refresh after temporary MQTT outages so stale local IP recovery retries immediately again.
* (copystring) Require bug reports to upload a `.txt` debug log file.

### 0.7.1 (2026-05-19)

* (copystring) Fixed local TCP recovery when a Roborock device gets a new LAN IP address.
* (copystring) Updated dependencies: `@napi-rs/canvas` to 1.0.0, `protobufjs` to 8.2.0 and `zod` to 4.4.3.
* (copystring) Resolved npm audit security advisories in transitive dependencies and documented the temporary dependency overrides.

### 0.7.0 (2026-05-04)

* (copystring) Added support for Roborock Q10, including map handling for this model.
* (copystring) Added support for Roborock Saros Z70.
* (copystring) Improved local connections for newer Roborock models so reconnects, keepalive checks and map transfers are more reliable.
* (copystring) Fixed empty images in `mapBase64` and `mapBase64Truncated`.

Older changelog entries are available in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 copystring <copystring@gmail.com>

See [LICENSE](LICENSE) for the full license text.
