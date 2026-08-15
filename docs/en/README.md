![Logo](../../admin/roborock.png)

# ioBroker.roborock

User documentation for the Roborock adapter for ioBroker. &ndash; [Deutsche Fassung](../de/README.md)

The adapter connects ioBroker to Roborock vacuum robots. It publishes the robot status,
the consumables, the cleaning history and the map, and it offers writable objects for
every command the connected model supports. Depending on the configuration it talks to
the robot over the local network, over the Roborock cloud, or over both.

Parts of this document are generated from the source code, so the reference tables can
never drift away from the implementation. Sections between `BEGIN`/`END` comments are
rewritten by `npm run docs`; everything else is written by hand.

- [Requirements](#requirements)
- [Setup](#setup)
- [Reference](#reference)
- [FAQ](#faq)

## Requirements

- Node.js >= 22.0.0
- ioBroker.js-controller >= 6.0.11
- ioBroker.admin >= 7.6.17
- A Roborock robot that is already set up in the Roborock app

## Setup

### 1. Install and create an instance

Install the adapter from the ioBroker admin repository and create an instance. The
configuration dialog has three tabs: **Account & connection**, **Map** and **Advanced**.
Every field is listed in the [configuration reference](#configuration-reference) below.

### 2. Choose the connection mode

The setting **Connection mode** decides whether the adapter is allowed to contact the
Roborock cloud at all.

| Mode | Value | What it does |
| --- | --- | --- |
| Cloud and local | `cloud` | Default. The adapter logs in to the Roborock cloud, reads the device list and then prefers the local connection for commands. Everything the adapter can do is available. |
| Local only (no cloud contact) | `local` | The adapter never sends a single request to the Roborock cloud. It only uses devices that are configured manually. There is no automatic fallback to the cloud. |

### 3a. Cloud setup (default)

1. Leave **Connection mode** at *Cloud and local*.
2. Pick the **Region** your Roborock account belongs to.
3. Enter your Roborock **Login** (the e-mail address of the account).
4. Choose the **Login Method**:
   - *Email + 2FA Code* (default): no password is stored. After the instance starts,
     Roborock sends a six digit code by e-mail. There is no input field for it in the
     dialog - write the code into the state `roborock.<instance>.loginCode` within
     15 minutes of the instance start.
   - *Email + Password*: enter the account password in the **Password** field.
5. Save and start the instance. The robots of the account appear below
   `roborock.<instance>.Devices.<duid>`.

### 3b. Cloud-free setup (local only)

In this mode the adapter needs to know each robot up front, because there is no cloud
device list to read. Two values are mandatory per robot:

- **`duid`** - the device id. It is visible on the local network: start the instance,
  then press **Search devices in network** on the configuration page. The button reports
  `duid`, IP address and protocol version of every robot that broadcasts on the LAN.
- **`localKey`** - a 16 character device secret. It cannot be derived locally and the
  adapter never publishes or logs it. It only exists in the Roborock cloud device list,
  and it only changes when the robot is paired again - so it has to be read once from
  that device list and can then be kept here forever.

Enter the robots as a JSON array in **Manual devices (JSON)**:

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

| Field | Required | Meaning |
| --- | --- | --- |
| `duid` | yes | Device id as reported by the network scan. |
| `localKey` | yes | 16 character device secret from the Roborock cloud device list. |
| `ip` | no | Static IP address. With it, UDP discovery is not needed for this robot. |
| `pv` | no | Protocol version: `1.0`, `A01`, `B01` or `L01`. Defaults to `1.0`. |
| `name`, `model`, `category`, `sn` | no | Cosmetic, except `sn`, which some B01 map decryptions need. |

The value is stored encrypted by js-controller and is never written to the log.

**What does not work without the cloud:** map retrieval, saved scenes, firmware
information and camera streaming currently need the cloud connection. In *Local only*
mode these functions fail with a clear message instead of silently falling back.

### 4. Optional: map and web UI

Enable **Enable Map Creation** on the *Map* tab to let the adapter render the map. The
map, the room selection and the dock and consumables panels are shown in the adapter's
own web UI tab inside the ioBroker admin interface - no manual URL is needed.

Above the map sits the cleaning mode - Vac & Mop, Mop, Vacuum - and below it the suction
level, mop route and water level as switch bars. The mode decides which steps are offered:
mopping shows no suction level, vacuuming no water level, and the MAX+ suction level
appears on the vacuum-only mode alone, because that is the only mode the robot keeps it
in. Switching the mode sends all three values in a single call. A robot that does not have
these modes keeps the plain level bars.

The map itself is a PNG the **adapter** renders, not something the browser draws, so it
cannot follow a dark admin on its own. **Map Colour Scheme** on the *Map* tab decides how
it is painted: *Light* is the picture the adapter has always produced and stays the
default, *Dark* uses the floor and wall colours of the Roborock app's own dark theme, and
*Follow the admin theme* takes whatever the Roborock tab reports. Because there is exactly
one rendered image per robot, that last option cannot serve two browsers in two themes -
the one that reported last decides what everyone sees. Changing the setting repaints the
stored maps at once and does not cost the robots a single request.

The **settings** panel carries the persistent robot settings. Today that is Do Not Disturb, the
child lock, obstacle avoidance, the dock's empty mode and the drying setting; it is the place
further settings will be added to. A control only
appears for a robot that really has the setting, and there are two ways the adapter finds that out:
some settings announce themselves in the status the robot sends anyway, and for the rest the adapter
**asks the robot once at start-up** whether it knows the matching read command. A robot that answers
gets the control; one that answers `unknown_method` does not. So an absent control means the robot
does not offer it, never that something failed to load.

That second way replaces guessing by model name, which was wrong in both directions: measured
against one robot, nine commands bound to another model's class turned out to work on it, and
eleven did not - two commands of the same function group could differ. Only the robot knows. Where
the answer is anything the adapter does not clearly recognise, it treats the setting as absent
rather than offering a control that might do nothing; a missing function is visible and can be
reported, a dead switch is not. Every label is the one the adapter published on the object, in the wording of the
Roborock app.

Do Not Disturb is a switch plus a start and an end. Two details are worth knowing because they come
from the protocol and not from a design choice: the robot has **no** separate on/off flag for it -
sending a window is what switches the mode on, and there is a separate command that switches it off
without touching the window. The panel therefore sends the window when you switch the mode on, and
a time you change while the mode is off is kept in the browser and sent when you switch it on. And
the window is in the **robot's own clock**, not in the ioBroker host's: the robot stores four plain
numbers with no time zone attached, and the Roborock app has a device time zone screen of its own
for exactly that reason. If the robot's time zone differs from yours, the quiet period sits at a
different hour than the one shown here. **That is now checkable:** where the robot can say so, its
zone stands in `deviceStatus.timezone` - on the test device `Europe/Berlin`, i.e. the same one.
Roborock puts the caveat this way itself: "Inaccurate robot time zone may affect DND mode accuracy."
The adapter only **reads** the zone; setting it is still done in the Roborock app.

The child lock is an ordinary switch. Both settings are also readable in the object tree, and both
are checked after they are sent: the robot answers `["ok"]` even to a setting it drops, so the
adapter compares what it asked for against what the robot reports afterwards and says so in the log
when the two disagree.

The **empty mode** decides how hard the dock empties the dustbin. It is a choice of four steps -
*Smart*, *Light*, *Balanced* and *Max* - in Roborock's own wording. Worth knowing: internally the
four steps are **not** numbered 0 to 3 but 0, 1, 2 and 4. Number 3 exists in the device but has no
name in any language and no place in the app's own picker, so the adapter does not offer it. If a
robot reports some other step by itself it is shown unchanged - what the device says about itself is
a fact - it simply cannot be written back.

The **drying setting** is a single choice rather than a switch plus a duration, because the protocol
has one call that always carries both. So the choice has a *No-Drying* position and the durations 2,
3, 4 and 5 hours. Setting it to *No-Drying* sends the last reported duration along with it, exactly
as the Roborock app does, which also sends a duration when switching drying off. The selected
duration and the on/off state are additionally readable as `deviceStatus.dryer_dry_time` and
`deviceStatus.dryer_enabled`. The five hour step appears on only one of the app's two drying
screens; whether every dock accepts it is not proven. If one rejects it, the command check says so
in the log.

Six more settings are plain on/off switches, and which of them a robot gets is again decided by
asking it: **Auto Emptying**, **Clean along floor direction**, **Adjusted Battery Level**, **FlexiArm
Design Extended Cleaning** for the side brush, **FlexiArm Design Extended Mopping** for the corners,
and **FlexiArm Design Extended Cleaning for Crevices**. Each is unlocked by its own read command, so a robot that
does not know one simply has no switch for it - the test device, measured, answers exactly one of
the five. Every label and every explanation is Roborock's own wording. None of these five appears in
the status the robot sends by itself, so the adapter reads each one once at start-up and again after
every change; there is also a read button per switch in the `queries` folder.

One of them is worth a caveat that comes from Roborock, not from this adapter: **Clean along floor
direction only does anything once a floor direction has been set for each room**, and that is set in
the Roborock app under *Edit Surface*. The switch here turns the behaviour on; it cannot set the
directions, because the two values that command carries are not established.

**Off-peak charging** is a second window of the day, beside Do Not Disturb and built the same way -
writing a window switches it on, a separate button switches it off, and there is no flag in between,
because the protocol has none. What it does is Roborock's own sentence: the robot fully charges only
inside the window and keeps a minimum charge outside it. It is a delay, not a block - Roborock says
so too: an unfinished clean and the minimum charge both still draw power at any hour.

One rule is worth knowing before the robot refuses: **the window has to span at least six hours.**
That is the app's own limit, and the app quietly stretches a shorter window to six. This adapter
refuses it instead and says so, because stretching means moving one end of a window the user set,
and unlike the app it has no way of knowing which end was meant. Whether the robot itself insists on
the six hours is not established; the limit is followed because sending what the app would never
send is how untested ground gets entered by accident.

The **volume** of the robot's own voice is a slider in the same panel, and a button beside it in
`commands` makes the robot speak once so the setting can be heard. Worth knowing where the range
comes from: the Roborock app's slider is narrower than the command allows, and how narrow depends on
the model - on the test device it runs 30 to 90 in steps of 5. The adapter offers **0 to 100**
instead, which is the range the app itself validates before sending on its numeric-input path. The
model-dependent window is deliberately not copied, because binding a range to a model name is
exactly the criterion this adapter has been removing. A robot that refuses a value outside its own
comfort window says so, and the command check reports it.

On a robot with more than one map, **the floor selector now marks the floor the robot is actually
on**. Those two things come apart the moment you look at the cellar while the robot cleans the
ground floor, and until now nothing said which was which. Beside it, under **map inventory**, the
adapter publishes which slot is loaded and what **backups** the robot says it keeps - one per map on
the test device, listed with the date they were taken and with the floor each belongs to.

The backups come with an honest caveat, and it is a state of its own: `mapInventory.restoreSupported`.
The robot is asked whether it can restore at all, and **the test device says no** - it lists two
backups and rejects the command the Roborock app itself uses to fetch the restore list. So those
backups are not usable, not by this adapter and not by the app. Saying so is the difference between
"this adapter has no button" and "this robot cannot do it". Nothing here deletes, restores or renames
a map; those are destructive and belong behind a confirmation, not on a button.

Under **device info** the robot's **serial number** and its **region block** appear, both read-only
and both only on a robot that answers for them: the voice package it runs, Roborock's `bom` string,
the region, the language of its voice and the time zone it keeps its clock in. Two things are
deliberate. The `bom` is published under that name and not as "firmware version", because the test
device reports firmware `V02.26.80` **and** `bom: A.03.0309` - two different strings for one robot,
and nothing establishes which one Roborock means by the version. And the serial number never appears
in a log line, not even at debug level: it identifies one specific machine.

Under **cleaning info** there is also the robot's **estimate** of the running clean: estimated total
and remaining area, total and remaining time, progress in percent, the battery the remaining area is
expected to need, and time and battery per square metre. These values only mean something during a
run; in the dock they describe the last one that finished. The adapter does not poll them - there is
a button for it in the `queries` folder.

The **cleaning history** sits below the dock panel, collapsed like its neighbours. It lists
the recorded runs newest first with the moment each one started, how long it took, how much
area it covered and what type of run it was - whole flat, zone, room selection - and it marks
only the runs the robot did not finish, because a mark on every normal run says nothing. Above
the list stand the lifetime totals the robot keeps: total area, total time, number of runs.

Clicking a run opens it in full, including **the map of that run**. The adapter has been
fetching and rendering those maps all along; until now nothing displayed them. They exist only
while **Enable Map Creation** is on - with it off the runs are still listed with all their
values, and the detail view says why there is no picture. The image is fetched when a run is
opened, not with the list, so twenty stored maps cost nothing until one of them is looked at.

Everything in this section is read from the object tree; the panel sends the robot nothing.
The wording of the run types and of the reasons a run ended is Roborock's own, taken from the
app's tables, and a code those tables do not list is shown as the plain number rather than
given an invented name. Values whose meaning is not proven - a B01 or Q10 device publishes
several - are listed under *More values* with the name and unit of their own object.

**Schedules: some robots keep them, others leave them on Roborock's server.** Which of the two a
robot does is not a question of its model - the app decides it from a flag the robot reports about
itself. On a robot of the second kind the list the adapter used to read is simply empty, so a
schedule that runs every day did not appear in ioBroker at all. Such schedules are now listed with
their identifier and whether they are switched on.

What is **not** there is their content. The app builds its schedule list from two sources: the
robot supplies the identifiers, and the times, rooms and cleaning modes come from your Roborock
account. Over the local connection they cannot be read, and this adapter does not fetch them. For
the same reason the switch of such a schedule is read-only here: turning a server-side schedule on
or off needs a command whose form has not been established, and a switch wired to the wrong command
would look like it works and do nothing.

The dock is drawn with the Roborock app's own picture of it, turned the way the robot
reports the dock to stand. Which picture depends on the reported dock type: a plain
charging dock gets a different graphic from a station that empties, washes or dries. Those
pictures are part of the device plugin the adapter downloads from your Roborock account,
so an instance running **Local only** has never received them - it keeps the adapter's
built-in dock symbol instead, and so does a robot that reports no dock type at all. The
maps of the B01/Q10 pipelines keep the built-in symbol as well.

### Driving the robot by hand

The **remote control** panel drives the robot with a nine-key pad, the way the Roborock app
does. It appears only for a robot whose own firmware reports that it can be driven; a robot
that does not report it gets no panel and no objects, so there is nothing to press that
would do nothing.

**It drives only while a key is held.** Every step the robot is sent carries a time limit of
1.5 seconds and is renewed roughly every 0.4 seconds - the app's own arrangement, and the
whole safety design. If the browser tab is closed, sent to the background, loses its
connection or freezes, no further step arrives and the robot stops by itself within one and a
half seconds. Nothing in the adapter repeats a step on its own, so a lost "stop" cannot leave
a robot driving. The arrow keys work as well while the panel is open, for the four straight
directions; the diagonals stay on the pad.

Starting is a mode, not a single command, and leaving it is a separate one. The adapter
therefore ends the mode by itself after two seconds without any instruction, ends it when the
adapter shuts down, and ends a mode that an earlier adapter run left open the next time it
starts. That last one only ever applies to a session this adapter opened - a robot being
driven from the phone app is left alone.

Two things it deliberately does not do. It does not interrupt a running job silently: if the
robot is cleaning, returning to the dock or driving to a spot, the panel asks first and then
pauses the job before it starts, exactly as the app does. And while the robot is installing
firmware it refuses outright.

There is **no position display during remote control**, and that is not an omission. The
robot writes its position about once every three seconds, so a marker on the map would be up
to three seconds behind the machine in the room - which is worse than none, because it looks
current. The Roborock app shows no map on its own remote page for the same reason. Roborock's
own advice stands at the top of the panel: keep an eye on the robot.

For scripts the same four calls sit in the `remoteControl` folder: a start button, a
direction with the nine positions the app can express, a stop and an end. A written direction
drives one step - at most 1.5 seconds - so a script has to repeat it to keep going, and the
adapter closes the mode two seconds after the last one either way.

## Reference

<!-- BEGIN:config -->

### Configuration reference

Every setting of the adapter instance, taken from the admin configuration definition.

#### Account & connection

> JSON array, one object per device: {"duid": "...", "localKey": "...", "ip": "192.168.1.50", "pv": "1.0"}. Optional: name, model, category, sn. The localKey is a 16 character device secret that only exists in the Roborock cloud device list and cannot be derived locally; it changes only when the device is paired again. Log in once with your account to read it, then keep it here. It is stored encrypted and never written to the log.

| Setting | Key | Type | Default | Description |
| --- | --- | --- | --- | --- |
| Login Method | `loginMethod` | `select` | `"email"` | With "Email + 2FA Code" Roborock sends a six digit code by email. There is no input field for it here: enter the code into the state roborock.&lt;instance&gt;.loginCode within 15 minutes of starting the adapter.<br>Options: `email` = Email + 2FA Code, `password` = Email + Password<br>Hidden when `data.connectionMode === 'local'` |
| Region | `region` | `select` | `"eu"` | Options: `eu` = Europe, `us` = United States, `cn` = China, `asia` = Asia<br>Hidden when `data.connectionMode === 'local'` |
| Login | `username` | `text` |  | Hidden when `data.connectionMode === 'local'` |
| Password | `password` | `password` |  | Hidden when `data.loginMethod !== 'password' \|\| data.connectionMode === 'local'` |
| Connection mode | `connectionMode` | `select` | `"cloud"` | Local only: the adapter never contacts the Roborock cloud. This requires manually configured devices with duid and localKey. Cloud based functions stay unavailable in this mode - map retrieval currently needs the cloud connection, as do saved scenes, firmware information and camera streaming. There is no automatic fallback to the cloud.<br>Options: `cloud` = Cloud and local, `local` = Local only (no cloud contact) |
| Manual devices (JSON) | `manualDevices` | `jsonEditor` | `""` | JSON array of { duid, localKey, ip, pv }. The localKey is a device secret and is stored encrypted. |
| Search devices in network | `scanLocalDevices` | `sendTo` |  | Listens for device broadcasts and reports duid, IP address and protocol version, so a manual entry can be created without a cloud account. The adapter instance must be running. |

#### Map

| Setting | Key | Type | Default | Description |
| --- | --- | --- | --- | --- |
| Enable Map Creation | `enable_map_creation` | `checkbox` |  |  |
| Map Theme | `map_theme` | `select` | `"dark"` | Room colours only. The floor, the walls and the driven path are set by the map colour scheme below.<br>Options: `dark` = Dark, `light` = Light<br>Hidden when `!data.enable_map_creation` |
| Map Colour Scheme | `map_color_scheme` | `select` | `"light"` | Floor, walls and driven path of the rendered map. 'Light' is the picture the adapter has always produced. 'Follow the admin theme' takes the theme the Roborock tab reports; since there is only one rendered image per robot, the browser that reported last decides what everyone sees.<br>Options: `light` = Light, `dark` = Dark, `auto` = Follow the admin theme<br>Hidden when `!data.enable_map_creation` |

#### Advanced

| Setting | Key | Type | Default | Description |
| --- | --- | --- | --- | --- |
| Update Interval | `updateInterval` | `number` |  | Seconds between two polls while the robot is idle or docked. Nothing changes in this state, so a long interval costs nothing; a short one only adds network traffic and load on the robot and on ioBroker. |
| Update interval while cleaning | `activePollInterval` | `number` | `5` | Seconds between two polls while the robot is cleaning, returning or washing. Lower values make position, area and progress follow more closely, but every poll is a request: they cost network traffic and load on both the robot and ioBroker. Below about 3 seconds the gain is barely visible. |
| Maximum wait after failed polls | `pollBackoffMaxInterval` | `number` | `300` | After a failed poll the adapter waits 30 seconds, then doubles the wait after each further failure, up to this limit. A low value notices a returning robot sooner but keeps retrying against an unreachable device; a high value keeps the log and the network quiet during a longer outage. |
| Live map update | `liveMapInterval` | `number` | `3` | Seconds between two checks for map changes while the robot is cleaning; while it stands still the adapter waits twice as long. The check itself is a small request that asks only what changed, and a complete map is transferred only when something actually did - so a low value costs far less than it looks, but it is still one request per interval on the robot, the network and ioBroker. Robots that do not offer the incremental map have to transfer the whole map every time and are therefore never checked faster than every 5 seconds. 0 switches the live update off; the map is then only refreshed by the normal poll. |
| Live position: pause between updates (ms) | `liveTrackInterval` | `number` | `1500` | Milliseconds the adapter waits after one answer before it asks for the robot position again. It is a pause, not a fixed rate: the next question goes out only once the previous answer has arrived, so the requests can never pile up and a slow connection simply slows the updates down instead. The default of 1500 ms comes from a measurement at a driving robot: it advances its own position only about every 3 seconds, so 95 percent of the requests in a 100 ms test returned the value they had already returned before. 1500 ms samples that roughly twice per update, which is enough not to skip a step. A shorter setting does not make the robot report more often - it only produces more requests, and the position it shows is on average about 1.5 seconds old whatever is configured here, because that is the robot's own update grid. 250 ms is the fastest allowed, kept well below the default so a model that updates faster than the measured one is not held back. Two limits apply automatically and cannot be undercut: while the robot stands still, and while it is only reachable through the Roborock cloud, the pause is at least 2 seconds. 0 switches the live position off; the robot is then only shown where the last map put it. Values from 1 to 30 are still read as the whole seconds this option used to count, so an existing setting keeps working - set a value of 250 or more to use the new unit. |
| Live position: match the robot | `liveTrackAuto` | `checkbox` | `true` | Lets the adapter work out how often this particular robot advances its position, and paces the live position channel accordingly. Switch it off to use the fixed value above instead. The default of 1500 ms was measured at one robot; a robot that reports three times as fast would be held back by it, and its owner would never learn that there is a setting to change. What the adapter measures is the distance between two observations of a change, not the moment the robot wrote it, and it can never resolve anything finer than the pause it is currently running at - so a faster robot is approached in steps rather than recognised at once. Only a robot that is actually working counts, never one standing in its dock, and the result never goes below the fastest allowed value or above the two seconds a standing robot gets. What the adapter settled on is written to the log and to the read-only state map.liveTrackLearnedPause of each robot. Setting the value above to 0 switches the live position off entirely, and this option cannot re-enable it. |
| Saved program execution | `sceneExecutionMode` | `select` | `"local"` | Local: runs the saved scene locally from its Roborock scene steps and keeps the local queue/resume. Cloud: starts the saved scene through Roborock cloud like the app. No automatic fallback between modes.<br>Options: `local` = Local adapter queue, `cloud` = Cloud like Roborock app |
| Listen for device broadcasts (UDP 58866) | `udpDiscoveryEnabled` | `checkbox` | `true` | Off: only devices with a statically configured IP address are used. Helpful when broadcasts are filtered (VLAN, WLAN client isolation, LXC or Docker bridges). |
| Network interface for discovery | `udpBindAddress` | `interface` |  | IP address or interface name (for example eth0) the UDP discovery socket binds to. Empty means all interfaces, which can fail on hosts with several networks.<br>Hidden when `!data.udpDiscoveryEnabled` |
| Hostname/IP for camera stream | `hostname_ip` | `text` |  |  |
| PIN for streaming the camera | `cameraPin` | `number` |  |  |

<!-- END:config -->

### Object tree

All device objects live below `roborock.<instance>.Devices.<duid>`:

| Folder | Content |
| --- | --- |
| `commands` | Writable buttons and value objects that trigger a cleaning run, change modes and so on. |
| `queries` | Writable objects that ask the robot for a specific piece of information. |
| `settings` | Writable objects that change a persistent robot setting. `set_dnd_timer` takes the Do Not Disturb window as `HH:MM-HH:MM` and switching the mode on is the same act as writing one; `close_dnd_timer` switches it off; `set_child_lock_status` is a plain switch. The window the robot currently holds is published read-only as `deviceStatus.dnd_start` and `deviceStatus.dnd_end`, and whether it is active as `deviceStatus.dnd_enabled`. |
| `deviceStatus` | The status the robot reports. Read only. |
| `consumables` | Remaining lifetime and run time of brushes, filters and sensors. |
| `resetConsumables` | One button per resettable consumable. |
| `cleaningInfo` | Lifetime totals (area, time, number of runs). |
| `cleaningInfo.records.<index>` | The individual cleaning runs of the history, newest first, with the rendered map of each run below `map`. |
| `floors` | One entry per stored map, including the button that loads it. |
| `schedules` | The robot's timers. A timer the robot keeps itself has `cron` and a writable `enabled` switch. A robot that keeps its schedules on Roborock's server instead gets one entry per schedule with `source: "server"`, a **read-only** `enabled` and `raw`, the entry exactly as the robot reported it - see below. |
| `programs` | The scenes saved in the Roborock app. |
| `map` | The rendered map and the room names. `map.liveTrackLearnedPause` reports, read only, the pause the adapter worked out for this robot's live position - see **Live position: match the robot** in the settings. It stays empty until enough position changes have been seen, and while the option is switched off. |
| `deviceInfo`, `networkInfo`, `connection` | Model and firmware information, network data and the state of the local/cloud channels. |
| `dockingStationStatus` | Dock states, only on models with a dock that reports them. |

#### What became of a command

Writing a command object is a request, not a result. The robot is asked afterwards, and it may
refuse, answer nothing at all, or answer `["ok"]` and keep doing what it did before. Until now that
only showed up in the adapter log, so a control could report success for something that never
happened.

The command state now says so itself. There is no extra state to look at - ioBroker's own state
model already carries it:

| The command state | What it means |
| --- | --- |
| `ack: false`, quality `0` | Somebody wants this. Nothing is known yet. |
| `ack: true`, quality `0` | The robot took it. |
| quality **not** `0`, comment set | It was tried and did not work. The comment says why. |

The quality is what a failure looks like from the object view, and it names the culprit as precisely
as it honestly can:

| Quality | Meaning here |
| --- | --- |
| `0x42` device not connected | Neither the local nor the cloud channel was up. Nothing was sent - certain. |
| `0x11` general instance problem | The adapter could not even build the request. Nothing was sent - certain. |
| `0x44` device error report | The robot answered something other than `["ok"]`. It refused. |
| `0x41` general device problem | The robot acknowledged and keeps reporting something else. The value did not take effect. |
| `0x01` bad | Either nothing came back at all, or something broke on the way. **Whether the robot carried the command out is unknown.** |

The last row is deliberate. A timeout is not a refusal, and this adapter cannot tell the difference
from outside - a quality that named a culprit would claim more than anybody knows. Which of the two
it was is in the comment.

The comment holds the reason as JSON, so it can be read in two ways at once: `m` is an English
sentence for anyone looking straight at the state, `k` and `a` are a translation key and its
arguments, which is what the admin tab shows in your own language.

Three things follow that are worth knowing:

* **The value stays where it was.** A failed command leaves the state unacknowledged, holding the
  value that was asked for. The next attempt clears the quality by itself, and a command that works
  clears it as well.
* **A button springs back either way.** One second after a press the button returns to `false` with
  `ack: true` - it really is not pressed any more - but it keeps the quality and the comment of the
  attempt.
* **Room cleaning, zone cleaning and driving to a point** are sent straight from the tab without a
  state being written. Their outcome still appears on their command objects,
  `commands.app_segment_clean`, `commands.app_zoned_clean` and `commands.app_goto_target`. The floor
  switch reports on the button that was pressed, `floors.<map>.load`.

One limitation, because it is easy to trip over: **`ioBroker.javascript` ignores state changes whose
quality is not `0`** unless a trigger says otherwise. A script listening to a command state is
therefore not woken by a failure. Nothing was written there before this change either, but it means
the quality is something to look at, not something that notifies.

The admin tab shows the failures, as a red message for a named one and an amber one for the two that
leave the question open. A command that simply worked is not announced: nothing there waits for a
confirmation, and a message per successful command would train you to look away from the very
channel that has to be read when something breaks.

Besides the tank and dust bag states, `dockingStationStatus` carries what the station is
doing with the mop. The robot reports that as raw numbers in `deviceStatus`
(`wash_status`, `wash_phase`, `wash_ready`, `dry_status`, `rdt`), and these six states are
those numbers read the way the Roborock app reads them:

| State | Meaning |
| --- | --- |
| `isWashing` | A wash task is running (the low byte of `wash_status` is not zero). |
| `washingTaskStatus` | That low byte itself. Only "not zero" has a documented meaning; the value range is enumerated nowhere, so it stays a plain number. |
| `washingMode` | The high byte of `wash_status`, that is *which* wash is running. Four modes have a wording; every other value keeps its number rather than borrowing a label. Meaningful only while `isWashing` is true. |
| `isWashReady` | The station can wash right away, without the robot driving back to it first. |
| `isDrying` | The station is drying the mop (`dry_status = 1`). |
| `dryRemainTime` | Minutes left of the drying run, from `rdt` (which stays in `deviceStatus` in seconds). |

A device that reports none of the raw fields gets none of these states. `wash_phase` keeps
its own value list in `deviceStatus` and gets no derived state, because only two of its
values are documented anywhere.

Three objects live at the instance root rather than under a device:

| State | Content |
| --- | --- |
| `loginCode` | Where the six digit code from the login e-mail is entered. |
| `mapTheme` | `light` or `dark`: the theme the Roborock admin tab last reported. Only consulted while **Map Colour Scheme** is set to *Follow the admin theme*; writing it by hand (from a script or a visualisation) works just as well as letting the tab do it. |
| `mapColorScheme` | `light` or `dark`: the colour set the map is actually painted with, i.e. **Map Colour Scheme** resolved against `mapTheme`. Read only. The admin tab reads it to draw its cleaning zones and its room marker in the colours of the map underneath, which is not the same decision as the admin's own light/dark theme. |

Object names and value lists are localised by the adapter at run time where the robot
firmware provides translations. The tables below show the English defaults from the
source code; the object ids themselves are language independent.

<!-- BEGIN:states -->

### States reference

All objects live below `roborock.<instance>.Devices.<duid>`. Writable command objects are grouped in the folders below, read only values from the robot follow further down.

#### `commands`

Writable objects in `Devices.<duid>.commands`.

| Object | Name | Type | Role | Default | Values / range | Models |
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
| `app_charge` | Charge | `boolean` | `button` | `false` |  | all |
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
| `app_pause` | Pause | `boolean` | `button` | `false` |  | all |
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
| `app_segment_clean` | Segment Cleaning | `boolean` | `button` | `false` |  | all |
| `app_segment_clean_subdivision` | Segment Clean Subdivision | `string` | `json` |  |  | 1/34 |
| `app_set_dirty_replenish_clean_status` | Set Dirty Replenish Clean Status | `string` | `json` |  |  | 1/34 |
| `app_set_dynamic_config` | Set Dynamic Config | `string` | `json` |  |  | 1/34 |
| `app_set_ignore_stuck_point` | Set Ignore Stuck Point | `string` | `json` |  |  | 1/34 |
| `app_set_low_space_zones` | Set Low Space Zones | `string` | `json` |  |  | 1/34 |
| `app_set_smart_cliff_forbidden` | Set Smart Cliff Forbidden | `string` | `json` |  |  | 1/34 |
| `app_skip_current_cleaning_area` | Skip Current Cleaning Area | `string` | `json` |  |  | 1/34 |
| `app_spot` | Spot Cleaning | `boolean` | `button` | `false` |  | 33/34 |
| `app_start` | Start | `boolean` | `button` | `false` |  | all |
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
| `app_stop` | Stop | `boolean` | `button` | `false` |  | all |
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
| `find_me` | Find Me | `boolean` | `button` | `false` |  | all |
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
| `set_clean_motor_mode` | Set Cleaning Mode | `string` | `value` |  | model dependent | 33/34 |
| `set_clean_repeat_times` | Clean Repeat Times | `number` | `value` | `1` | `1` = 1x<br>`2` = 2x | 33/34 |
| `set_clean_sequence` | Cleaning order (segment IDs, [] resets) | `string` | `json` | `"[]"` |  | 33/34 |
| `set_custom_mode` | Fan Power | `number` | `level` |  | model dependent | 33/34 |
| `set_mop_mode` | Mop Mode | `number` | `level` |  | model dependent | 33/34 |
| `set_voice_chat_volume` | Set Voice Chat Volume | `number` | `value` | `0` |  | 1/34 |
| `set_water_box_custom_mode` | Water Box Mode | `number` | `level` |  | model dependent | 33/34 |
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

Writable objects in `Devices.<duid>.queries`.

| Object | Name | Type | Role | Default | Values / range | Models |
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

Writable objects in `Devices.<duid>.settings`.

| Object | Name | Type | Role | Default | Values / range | Models |
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

Values reported by the robot in `Devices.<duid>.deviceStatus`.

| Object | Name | Type | Unit | Values |
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

Values reported by the robot in `Devices.<duid>.consumables`.

| Object | Name | Type | Unit | Values |
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

Values reported by the robot in `Devices.<duid>.cleaningInfo`.

| Object | Name | Type | Unit | Values |
| --- | --- | --- | --- | --- |
| `0` |  | `number` | `h` | [h] |
| `1` |  | `number` | `m²` | [m²] |
| `clean_area` |  | `number` | `m²` | [m²] |
| `clean_count` |  | `number` |  |  |
| `clean_time` |  | `number` | `h` | [h] |
| `dust_collection_count` |  | `number` |  |  |

#### `cleaningInfo.records.<index>`

Values reported by the robot in `Devices.<duid>.cleaningInfo.records.<index>`.

| Object | Name | Type | Unit | Values |
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

#### Resettable consumables

These consumables get a button below `Devices.<duid>.resetConsumables` that resets the counter in the robot.

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

### Supported models

The adapter ships 34 model profiles. A robot whose model id is not listed still works with a generic profile, but without the model specific commands. "Command objects" counts the writable objects the profile creates, "Features" the capabilities it declares statically (dock, camera, mop wash and so on).

| Model | Model id | Protocol | Command objects | Features |
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

**The instance stays yellow and the log asks for a login code.**
The login method *Email + 2FA Code* is active. Roborock sent a six digit code to the
account e-mail address. Write it into `roborock.<instance>.loginCode` within 15 minutes
of the instance start; there is no input field in the configuration dialog.

**No robot is found although it is in the same network.**
The adapter listens for device broadcasts on UDP port 58866. Some networks filter them
(VLANs, WLAN client isolation, LXC or Docker bridges). Either give the robot a static IP
address in the manual device configuration, or select the correct interface under
**Network interface for discovery**.

**The map stays empty.**
Map creation has to be enabled on the *Map* tab, and the map currently needs the cloud
connection. In *Local only* mode no map is retrieved.

**A command object exists but the robot does not react.**
Not every command is supported by every model. The [states reference](#states-reference)
lists for each object how many of the model profiles offer it. If the object is present
but the robot ignores it, the firmware of that specific model may not implement it.

**Where do I see why the robot stopped?**
`deviceStatus.error_code` carries the numeric reason, `deviceStatus.state` the current
activity. The meaning of every error code is listed below.

<!-- BEGIN:errors -->

### Error codes

Values of `deviceStatus.error_code`. The adapter also publishes the resolved text in `deviceStatus.error_code` value list.

<details>
<summary>Error codes (137)</summary>

| Code | Meaning |
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

## Support

Issues and questions belong into the
[GitHub issue tracker](https://github.com/copystring/ioBroker.roborock/issues).
Please include the adapter version, the robot model id and the relevant part of the log
with the log level set to `debug`.

## License

MIT - see the [LICENSE](../../LICENSE) file of the repository.
