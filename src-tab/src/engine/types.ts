/**
 * The contract between the map engine and its React shell.
 *
 * The engine keeps the whole D3/SVG drawing logic of the former standalone page. What changed
 * is only its edges: instead of reaching into a fixed HTML document it publishes plain view
 * models through {@link MapEngineHost} and receives its ioBroker access through
 * {@link EngineConnection}. React renders the models; nothing in here knows about React.
 */

/** One robot the adapter published below `Devices.`. */
export interface RobotEntry {
	duid: string;
	name: string;
}

/** A `value -> label` pair taken from an object definition's `common.states`. */
export interface SelectOption {
	value: string;
	label: string;
}

/** The live device status shown in the status strip. */
export interface StatusModel {
	/** Already resolved through `common.states`, or null while unknown. */
	stateText: string | null;
	battery: number | null;
	/** Cleaned area in m². */
	cleanArea: number | null;
	/** Cleaning duration in minutes. */
	cleanTime: number | null;
	/** Resolved error text, or null when the device reports no error. */
	errorText: string | null;
	/** Transport channel of the local/cloud work package, empty while the device publishes none. */
	connectionChannel: string;
	/** True while the robot reports a running job; the shell then offers Pause instead of Start. */
	running: boolean;
}

/** One of the fan / mop / water selectors, built from `commands.*.common.states`. */
export interface ModeModel {
	command: string;
	/** Translation key of the caption. */
	labelKey: string;
	options: SelectOption[];
	/** Currently reported value, or null while unknown. */
	value: string | null;
}

/** One published value of a consumable, e.g. remaining hours or remaining percent. */
export interface ConsumableMetricModel {
	name: string;
	/** Formatted value including its unit, or "–" while unknown. */
	text: string;
}

/** One physical part, grouping every value the adapter publishes for it. */
export interface ConsumablePartModel {
	part: string;
	name: string;
	metrics: ConsumableMetricModel[];
	/** Remaining share of the declared lifetime, or null when no range is published. */
	percent: number | null;
	/** True once the part reached the end of its declared life. */
	due: boolean;
	/** State name inside `resetConsumables`, or null when the device offers no reset. */
	resetCommand: string | null;
}

/** One dock command rendered into the dock panel. */
export interface DockControlModel {
	command: string;
	label: string;
	kind: "button" | "switch" | "select";
	options: SelectOption[];
	value: string | null;
}

/** One station state shown in the dock panel. */
export interface DockStatusModel {
	stateId: string;
	name: string;
	/** Formatted value including its unit, or "–" while unknown. */
	text: string;
}

/** Everything the dock panel needs. */
export interface DockModel {
	controls: DockControlModel[];
	status: DockStatusModel[];
	/** True while the device reports a station fault; flagged on the collapsed summary. */
	faulty: boolean;
}

/** Room selection state of the currently displayed map. */
export interface RoomSelectionModel {
	/** Number of rooms the user picked. */
	selected: number;
	/** Number of rooms the current map offers at all. */
	available: number;
}

/** Zone selection state. */
export interface ZoneModel {
	count: number;
	max: number;
	/** True once the zone limit is reached. */
	atLimit: boolean;
}

/** The obstacle photo the user opened from the map. */
export interface ObstaclePhotoModel {
	/** Complete data URL. */
	image: string;
	bbox: { x: number; y: number; w: number; h: number; imageWidth: number; imageHeight: number } | null;
}

/**
 * Callbacks the engine pushes its state through. Every one of them is optional at call time -
 * the shell installs them all, but the engine must survive a host that installs none.
 */
export interface MapEngineHost {
	/** Element the engine draws the SVG map and its hover popup into. */
	container: HTMLElement;
	/** Translates a key, falling back to the English literal. `%s` placeholders are filled in order. */
	t: (key: string, fallback: string, ...args: (string | number)[]) => string;
	onRobots?: (robots: RobotEntry[], selected: string | null) => void;
	onStatus?: (status: StatusModel) => void;
	onModes?: (modes: ModeModel[]) => void;
	onFloors?: (floors: SelectOption[], selected: string | null) => void;
	onRooms?: (rooms: RoomSelectionModel) => void;
	onZones?: (zones: ZoneModel) => void;
	onConsumables?: (parts: ConsumablePartModel[]) => void;
	onDock?: (dock: DockModel) => void;
	/** True as soon as any map content arrived; the shell then hides the "waiting for map" hint. */
	onMapPresence?: (hasMap: boolean) => void;
	/** True while the user is placing a go-to target. */
	onGoToMode?: (active: boolean) => void;
	/** A failure that belongs into the UI instead of the browser console. */
	onError?: (message: string) => void;
	/** The large obstacle photo, or null when it should close. */
	onObstaclePhoto?: (photo: ObstaclePhotoModel | null) => void;
}

/**
 * The slice of the ioBroker socket the engine uses. `GenericApp` hands in its own connection,
 * so the engine no longer opens a second socket of its own.
 */
export interface EngineConnection {
	sendTo(instance: string, command: string, data: unknown): Promise<any>;
	getObject(id: string): Promise<any>;
	/** Current value of every requested state; missing states resolve to null. */
	getStates(ids: string[]): Promise<Record<string, any>>;
	subscribeState(id: string, handler: (id: string, state: any) => void): Promise<void>;
	unsubscribeState(id: string, handler: (id: string, state: any) => void): void;
	/** ioBroker object view, e.g. ("device", start, end) or ("state", start, end). */
	getObjectViewSystem(type: string, start: string, end: string): Promise<Record<string, any>>;
}
