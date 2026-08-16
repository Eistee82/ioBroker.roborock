// src/lib/features/base_device_features.ts
import { z } from "zod";

import type { Roborock } from "../../main";
import { UNKNOWN_METHOD_ANSWER } from "../commandFeedback";
import { DeviceStateWriter } from "./deviceStateWriter";
import { Feature } from "./features.enum";

// --- Types & Interfaces ---

/**
 * Command object properties.
 */
export type CommandSpec = {
	type: ioBroker.CommonType | "json"; // 'json' type used for internal logic
	def?: any;
	states?: Record<string | number, string>;
	min?: number;
	max?: number;
	unit?: string;
	role?: string;
};

/**
 * Feature implementation function, 'this' context is bound.
 */
export type FeatureImplementation = () => Promise<void> | void;

/**
 * Model-specific configuration.
 */
export interface DeviceModelConfig {
	staticFeatures: Feature[]; // Features this model always has
}

/**
 * Feature class constructor signature.
 */
export type FeatureClassConstructor = new (_dependencies: FeatureDependencies, _duid: string) => BaseDeviceFeatures;

/**
 * Dependencies injected into feature classes.
 */
export interface FeatureDependencies {
	adapter: Roborock;
	config: Roborock["config"];
	http_api: Roborock["http_api"];
	ensureState: Roborock["ensureState"];
	ensureFolder: Roborock["ensureFolder"];
	log: Roborock["log"];
	// Add other dependencies if needed
}

/**
 * The state name for an answer that has no keys of its own.
 *
 * An object answer names its own states; an array or a bare value does not, so the method has to.
 * `get_fw_features` becomes `fw_features`, `get_room_mapping` becomes `room_mapping` - the same
 * name the robot's own field would carry, which keeps `firmwareFeatures.fw_features` readable
 * instead of `firmwareFeatures.get_fw_features`.
 *
 * Two details that are not cosmetic:
 *
 * - Roborock's method table carries both plain and `user.`-prefixed forms of the same call
 *   (`'GetTimer': 'user.get_timer'` and `'GetTimer': 'get_timer'`, control plugin A65:238176 and
 *   A65:238179). Only the part behind the last dot is a name; keeping the prefix would split one
 *   value across two states depending on which table a device happens to use.
 * - Everything outside `[A-Za-z0-9_]` is replaced. The result is appended to an object path, and a
 *   method name is not a trusted string - it reaches this function from a model class, and B01
 *   builds it from device data. Same reasoning as `SAFE_PATH_SEGMENT` on the command handlers.
 * @param method The RPC method name.
 * @returns A path-safe state name, never empty.
 */
export function resultStateKeyForMethod(method: string): string {
	let key = method.slice(method.lastIndexOf(".") + 1);

	for (const prefix of ["app_get_", "get_", "app_"]) {
		if (key.startsWith(prefix) && key.length > prefix.length) {
			key = key.slice(prefix.length);
			break;
		}
	}

	key = key.replace(/[^A-Za-z0-9_]/g, "_");
	return key.length > 0 ? key : "result";
}

// --- Registry & Decorator ---

/** Maps robotModelId to feature class constructors. */
const modelRegistry = new Map<string, FeatureClassConstructor>();

/**
 * Decorator to register a feature class for a robot model.
 * @param robotModelId Unique model identifier (e.g. 'roborock.vacuum.a70').
 */
export function RegisterModel(robotModelId: string) {
	return function (constructor: FeatureClassConstructor) {
		if (modelRegistry.has(robotModelId)) {
			// Model already registered, overwriting.
		}
		modelRegistry.set(robotModelId, constructor);
	};
}

// --- Zod Schemas (Base) ---

/**
 * Base Zod schema for generic status properties.
 */
export const BaseStatusSchema = z.looseObject({
	error_code: z.number().int().optional(),
	// Add generic status fields if applicable
});

// --- Generic Base Class ---

/**
 * Base class for device features. Handles init, feature application, and commands.
 * Extended by specific types (e.g. V1VacuumFeatures).
 */
export abstract class BaseDeviceFeatures {
	protected createdStates: Set<string> = new Set(); // Track created states to avoid redundant ensureState calls
	protected runtimeDetectionComplete = false; // Initial runtime detection flag
	protected readonly stateWriter: DeviceStateWriter;

	protected deps: FeatureDependencies;
	public commands: Record<string, CommandSpec | any>; // Command definitions for this device
	public extraCommandGroups: Record<string, Record<string, CommandSpec | any>>;
	protected duid: string;
	protected robotModel: string;
	public protocolVersion: string | null = null;
	protected config: DeviceModelConfig; // Static feature config from model class
	protected appliedFeatures = new Set<Feature>(); // Tracks applied features
	protected pendingFeatures = new Set<Feature>(); // Tracks features currently being applied (Race Condition Guard)
	protected commandsCreated = false; // Command objects created flag

	// --- Constants (Generic) ---
	protected static readonly CONSTANTS = {
		// Generic constants for all Roborock devices
		baseCommands: {},
		// Generic error codes (subset)
		errorCodes: {
			0: "No error",
			255: "Internal error",
			"-1": "Unknown Error",
			// Add more if generic across all devices
		},
	};

	// --- Metadata Key for Feature Registry ---
	// Unique symbol for registry on prototype
	public static readonly FEATURE_METADATA_KEY = Symbol.for("roborock.featureRegistry");

	/**
	 * Decorator to register a feature handler method.
	 *
	 * ## It lands in one of two places, and that is not this file's choice
	 *
	 * Written for TypeScript's **legacy** decorators (`experimentalDecorators`, which
	 * `tsconfig.json` sets): the first argument is then the **prototype**, the second the method
	 * name, and the registry ends up where {@link findFeatureMethod} looks first.
	 *
	 * Under the **standard** decorator proposal the same call gets `(methodFunction, context)`
	 * instead, so the registry ends up on the **method function** and its values are context
	 * objects rather than names. Which of the two applies is decided by the toolchain that
	 * transpiles this file, not by the code - see {@link findFeatureMethod} for the measurements
	 * and why the reader takes both.
	 *
	 * @param feature The Feature enum key.
	 */
	public static DeviceFeature(feature: Feature) {
		// `target` is the prototype under legacy decorators and the method function under the
		// standard ones; `propertyKey` is the method name or the context object to match.
		return function (target: any, propertyKey: any) {
			let registry: Map<Feature, unknown> = target[BaseDeviceFeatures.FEATURE_METADATA_KEY];
			if (!registry) {
				registry = new Map();
				target[BaseDeviceFeatures.FEATURE_METADATA_KEY] = registry;
			}
			registry.set(feature, propertyKey);
		};
	}

	/**
	 * The name of the method registered for a feature, whichever way the decorator was compiled.
	 *
	 * ## Why this is not a single property read
	 *
	 * `@alcalzone/esbuild-register` - the loader js-controller starts a TypeScript adapter with -
	 * reads only `jsxFactory`, `jsxFragment` and `target` out of `tsconfig.json`
	 * (`dist/node.js:2710-2719`). **`experimentalDecorators` is not among them**, so esbuild never
	 * learns that this project means the legacy semantics, and what it does instead depends on its
	 * own version. Measured, each time with the conditions of an installed adapter (no
	 * `tsconfig.json` is shipped, so no `target` is passed either):
	 *
	 * | esbuild | what it emits | consequence |
	 * | --- | --- | --- |
	 * | 0.11.23 - 0.17.19 | `__decorateClass(…, X.prototype, …)` | legacy: registry on the prototype |
	 * | 0.18.20 - 0.20.2 | the decorator, verbatim | `SyntaxError` - the instance never starts |
	 * | 0.21.5 and later | standard decorators | registry on the **method function** |
	 *
	 * An installation gets esbuild **0.11.23** today: `@alcalzone/esbuild-register` depends on
	 * `esbuild: ^0.11.5` and exists in exactly one version, so the first row is what runs and
	 * everything works. This repository pins `esbuild: ^0.25.12` for it (`package.json`,
	 * `overrides`), which is why a plain `node -r @alcalzone/esbuild-register` **here** lands in
	 * the third row and finds no features at all.
	 *
	 * Reading both places costs nothing in the normal case - the prototype is a single property
	 * read - and removes a dependency on which esbuild happens to be installed. **It does not
	 * remove all of it:** the middle row fails before any of this code runs, and nothing written
	 * in JavaScript can catch a `SyntaxError` in its own module.
	 *
	 * ## The order, and why it is fixed rather than incidental
	 *
	 * The prototype wins. It is the form this project declares in `tsconfig.json` and the one every
	 * test runs under, so where both exist it is the intended one; the method-borne registry only
	 * appears when a toolchain silently chose otherwise. The scan is also the more expensive of the
	 * two, and skipping it whenever the prototype answers keeps the normal path exactly as it was.
	 *
	 * @param feature The Feature enum key.
	 * @returns The method name, or undefined when no method is registered for this feature.
	 */
	private findFeatureMethod(feature: Feature): string | undefined {
		const key = BaseDeviceFeatures.FEATURE_METADATA_KEY;

		// Legacy form: one registry inherited through the prototype chain, values are method names.
		const onPrototype: Map<Feature, unknown> | undefined = (this as any)[key];
		const declared = onPrototype?.get(feature);
		if (typeof declared === "string") return declared;

		// Standard form: one registry per decorated method, values are context objects whose `name`
		// is the method name. Walked rather than indexed, because the name is what we are looking for.
		let proto = Object.getPrototypeOf(this);
		while (proto && proto !== Object.prototype) {
			for (const name of Object.getOwnPropertyNames(proto)) {
				// `getOwnPropertyDescriptor` rather than `proto[name]`: reading a getter here would
				// run it on the prototype, and several of them touch instance state.
				const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
				if (typeof value !== "function") continue;

				const onMethod: Map<Feature, unknown> | undefined = value[key];
				const context = onMethod?.get(feature);
				if (context === undefined) continue;

				// The context object carries the name; fall back to the property it was found under,
				// which is the same string in every case measured so far.
				const fromContext = (context as { name?: unknown }).name;
				return typeof fromContext === "string" ? fromContext : name;
			}
			proto = Object.getPrototypeOf(proto);
		}

		return undefined;
	}

	// --- Feature Registry (Instance Based via Metadata) ---

	/**
	 * Base feature handler constructor.
	 * @param dependencies Injected dependencies.
	 * @param duid Device unique identifier.
	 * @param robotModel Robot model string.
	 * @param config Static feature config.
	 */
	constructor(dependencies: FeatureDependencies, duid: string, robotModel: string, config: DeviceModelConfig) {
		this.deps = dependencies;
		this.duid = duid;
		this.robotModel = robotModel;
		this.config = config;
		this.stateWriter = new DeviceStateWriter(dependencies, duid);
		// Initialize empty commands map. Actual commands will be populated during setupProtocolFeatures.
		this.commands = {};
		this.extraCommandGroups = {};
	}

	/**
	 * Applies a feature if not already applied. Looks up implementation in registry.
	 * @param feature Feature enum key.
	 * @returns `true` if applied now.
	 */
	protected async applyFeature(feature: Feature): Promise<boolean> {
		// Validate input feature
		if (!feature || !Object.values(Feature).includes(feature)) {
			this.deps.log.warn(`[${this.duid}] Attempted to apply invalid feature value: ${feature}`);
			return false;
		}
		// Check if already applied or pending
		if (this.appliedFeatures.has(feature) || this.pendingFeatures.has(feature)) {
			return false;
		}

		// Whichever way the decorator was compiled; see findFeatureMethod.
		const methodName = this.findFeatureMethod(feature);
		if (methodName === undefined) return false;

		this.pendingFeatures.add(feature); // Lock
		try {
			const applyMethod = (this as unknown as Record<string, () => Promise<void>>)[methodName];
			if (typeof applyMethod !== "function") throw new Error(`Feature ${String(feature)}: missing method ${methodName}`);
			await applyMethod.call(this);
			this.appliedFeatures.add(feature); // Mark applied after success
			return true;
		} catch (e: unknown) {
			const stack = e instanceof Error ? e.stack : "";
			this.deps.log.error(`[FeatureApply|${this.robotModel}|${this.duid}] Error applying feature '${feature}': ${this.deps.adapter.errorMessage(e)} ${stack}`);
			return false;
		} finally {
			this.pendingFeatures.delete(feature); // Unlock
		}
	}

	// --- Abstract / Overridable Methods ---

	/**
	 * Detects features via device-specific mechanisms (bitfields, fw info).
	 * Implemented by subclasses.
	 * @returns Set of detected `Feature` enum keys.
	 */
	protected abstract getDynamicFeatures(): Set<Feature>;

	/**
	 * Applies static features from config.
	 * Override for pre-runtime model logic.
	 * @param _statusData Optional initial status data.
	 * @param _fwFeatures Optional initial firmware features.
	 */
	public async applyModelSpecifics(): Promise<void> {
		const promises = this.config.staticFeatures.map((feature) => this.applyFeature(feature));
		await Promise.all(promises);
	}

	/**
	 * Performs runtime feature detection using status data.
	 * Implemented by subclasses.
	 * @param statusData Validated status data.
	 * @param fwFeatures Optional firmware features.
	 * @returns `true` if features/commands changed.
	 */
	public abstract detectAndApplyRuntimeFeatures(_statusData: Readonly<Record<string, any>>): Promise<boolean>;

	/**
	 * Runs the runtime feature detection and writes the objects it added.
	 *
	 * ## Why this exists
	 *
	 * `initialize()` writes the command objects in step 3 and only asks the robot for its status in
	 * step 4. The status is the only thing that can say what a robot really has - it is what
	 * switches on mop drying, Do Not Disturb and the child lock - so every command those features
	 * register arrived **after** the objects had been written, and nothing wrote them afterwards.
	 * `detectAndApplyRuntimeFeatures` even reported that something had changed; its return value was
	 * discarded at all three call sites. The result was a feature that existed in memory and nowhere
	 * else: no object, no control in the admin tab, no way to use it.
	 *
	 * ## Why it re-runs `createCommandObjects()` and not `initialize()`
	 *
	 * `initialize()` would be the wrong call and would look like the right one.
	 * `setupProtocolFeatures()` resets `this.commands` and `this.extraCommandGroups` to the base set,
	 * and `applyFeature()` skips a feature that is already applied - so a second `initialize()` would
	 * throw away exactly the commands this is meant to publish and never put them back.
	 *
	 * ## Why running it twice is cheap
	 *
	 * `processCommand` compares the stored `common` against the one it would write and only touches
	 * the object when they differ, so everything that already exists costs one read and no write.
	 * Where a definition really did change, the write goes through `applyCommonUpdate`, which
	 * replaces the object outright when the update *removes* something - js-controller's own merge
	 * can add and overwrite but never delete (`main.ts`, `applyCommonUpdate`;
	 * `test/unit/object_common_shrink.test.ts`).
	 *
	 * ## Why the trigger is a new command and not the `changed` flag
	 *
	 * `changed` is broader than "there is something to publish". Every implementation sets it when
	 * the detection runs for the first time, and the B01 one sets it whenever the status carries
	 * `dss` - whether or not a single command was added. Acting on that would give **every** device
	 * an object pass it never had before, including the B01 and Q10 devices this project has no
	 * hardware to test against.
	 *
	 * So the flag is not the trigger; the command inventory is. Only when the detection really
	 * registered a command that was not there before does anything get written, and a device whose
	 * detection adds nothing behaves exactly as it did. That is the narrowest condition that still
	 * closes the gap.
	 *
	 * @param statusData The robot's status, as the caller received it.
	 * @returns Whether new command objects were published.
	 */
	protected async applyRuntimeFeatureDetection(statusData: Readonly<Record<string, any>>): Promise<boolean> {
		// The same guard all three call sites carried before, kept in one place so the pairing of
		// "detect" and "publish what was detected" cannot come apart again.
		if (this.runtimeDetectionComplete) return false;

		const before = this.commandInventory();
		await this.detectAndApplyRuntimeFeatures(statusData);
		const added = this.commandInventory().filter((entry) => !before.includes(entry));

		if (added.length === 0) return false;

		this.deps.adapter.rLog("System", this.duid, "Debug", this.protocolVersion || undefined, undefined,
			`Runtime detection added ${added.length} command(s): ${added.join(", ")}. Publishing their objects.`, "debug");
		await this.createCommandObjects();
		return true;
	}

	/**
	 * Asks the robot which of the probeable commands it knows, and registers those it does.
	 *
	 * Runs from `initialize()` before the objects are written, and only when the device is online.
	 * The default does nothing: a protocol that was never measured this way must not start sending
	 * probes on a guess. `V1VacuumFeatures` overrides it.
	 */
	protected async detectProbedCapabilities(): Promise<void> {
		// No probe by default; see the class comment of CapabilityProbe for why silence is the
		// safe answer for a device nobody has measured.
	}

	/**
	 * Ends a remote control session before the adapter goes down.
	 *
	 * Called from `onUnload`, which js-controller does not let anybody await - so this can only
	 * start the two closing calls, never see them arrive. It is deliberately a no-op by default:
	 * only `V1VacuumFeatures` can enter the mode in the first place, and a protocol that has no such
	 * mode must not start sending calls into a shutdown.
	 *
	 * The robot is not left driving either way: every `app_rc_move` carries `duration: 1500`, so it
	 * stops by itself within 1.5 s of the last one. What this saves is the **mode**; what saves it
	 * when the adapter did not get this far is the recovery on the next start.
	 */
	public shutdownRemoteControl(): void {
		// Nothing to end on a device that cannot be driven by hand.
	}

	/** Every registered command as `folder.name`, for telling "something was added" from "something happened". */
	private commandInventory(): string[] {
		const inventory = Object.keys(this.commands).map((name) => `commands.${name}`);
		for (const [folder, group] of Object.entries(this.extraCommandGroups)) {
			for (const name of Object.keys(group)) inventory.push(`${folder}.${name}`);
		}
		return inventory;
	}

	// --- Core Initialization Logic ---

	/**
	 * Initializes features: Model Specifics -> Runtime Detection -> Dock Processing -> Command Objects.
	 * @param initialStatus Optional initial status.
	 * @param initialFwFeatures Optional initial firmware features.
	 */
	public async initialize(online: boolean = false): Promise<void> {
		// Flow: Protocol -> Model Specifics -> Runtime Detection -> Dock Processing -> Command Objects

		// 0. Setup Protocol Features (Command Sets)
		try {
			await this.setupProtocolFeatures();
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Error setting up protocol features: ${this.deps.adapter.errorMessage(e)}`, "error");
		}

		// 1. Apply Model Specifics
		try {
			await this.applyModelSpecifics();
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Error applying model specifics: ${this.deps.adapter.errorMessage(e)}`, "error");
		}

		// 1b. Ask the robot what it can, while an answer can still decide whether an object is
		// created at all. That is the whole point of doing it here rather than later: a control
		// that is never created cannot be a control that writes into the void.
		//
		// A device that is offline is not asked and is offered nothing - the same direction of
		// error the probe itself takes, see `capabilityProbe.ts`.
		if (online) {
			try {
				await this.detectProbedCapabilities();
			} catch (e: unknown) {
				this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Error probing capabilities: ${this.deps.adapter.errorMessage(e)}`, "warn");
			}
		}

		// 2. Create/Update ioBroker Objects (Commands)
		// Must be done BEFORE fetching data, as data updates might sync to command states.
		try {
			await this.createCommandObjects();
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Error creating command objects: ${this.deps.adapter.errorMessage(e)}`, "error");
		}

		// 3. Fetch initial data if online
		if (online) {
			try {
				await this.initializeDeviceData();
			} catch (e: unknown) {
				this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Error initializing device data: ${this.deps.adapter.errorMessage(e)}`, "error");
			}
		}
	}

	/**
	 * Fetches initial runtime data (status, consumables, map).
	 */
	public async initializeDeviceData(): Promise<void> {
		// Default implementation: update status if online
		await this.updateStatus();
		await this.updateFirmwareFeatures();
		await this.updateMap();
	}

	public async setupProtocolFeatures(): Promise<void> {
		// Initialize with generic base commands
		this.commands = JSON.parse(JSON.stringify(BaseDeviceFeatures.CONSTANTS.baseCommands));
		this.extraCommandGroups = {};
	}

	/**
	 * Logs summary of applied features and commands. Call after init.
	 */
	public printSummary(): void {
	}

	// --- Core Helper Methods ---

	/**

	 * Maps dynamic feature keys (e.g. 'is...') to action keys (e.g. 'MopWash').
	 * @param detectedFeature Detected Feature enum key.
	 * @returns Mapped action Feature key, detected key if actionable, or null.
	 */
	protected mapFeature(detectedFeature: Feature): Feature | null {
		// Get registry from instance metadata
		const registry: Map<Feature, string> | undefined = (this as any)[BaseDeviceFeatures.FEATURE_METADATA_KEY];

		// Check if 'is...' key value exists as enum key
		const potentialActionName = Feature[detectedFeature as keyof typeof Feature];
		// Find enum key for string value, excluding original key
		const mappedActionKey = (Object.keys(Feature) as Array<keyof typeof Feature>).find((key) => Feature[key] === potentialActionName && key !== detectedFeature);

		if (mappedActionKey) {
			const actionFeatureEnum = Feature[mappedActionKey];
			// Check if mapped action has registered implementation
			if (registry && registry.has(actionFeatureEnum)) {
				this.deps.adapter.rLog("System", this.duid, "Debug", undefined, undefined, `Mapping dynamic feature '${detectedFeature}' to action '${actionFeatureEnum}'`, "debug");
				return actionFeatureEnum;
			} else {
				this.deps.adapter.rLog("System", this.duid, "Debug", undefined, undefined, `Dynamic feature '${detectedFeature}' mapped to '${actionFeatureEnum}', but no action registered.`, "debug");
				return null;
			}
		}

		// Check if detected feature has registered action
		if (registry && registry.has(detectedFeature)) {
			this.deps.adapter.rLog("System", this.duid, "Debug", undefined, undefined, `Using dynamic feature '${detectedFeature}' directly.`, "debug");
			return detectedFeature;
		}

		// No mapping or action found
		this.deps.adapter.rLog("System", this.duid, "Debug", undefined, undefined, `Dynamic feature '${detectedFeature}' detected but has no registered action or mapping.`, "debug");
		return null;
	}

	/**
	 * Creates/updates ioBroker command objects from this.commands.
	 */
	public async createCommandObjects(): Promise<void> {
		const commandGroups: Record<string, Record<string, CommandSpec | any>> = {
			commands: this.commands,
			...this.extraCommandGroups
		};

		const promises: Promise<void>[] = [];
		for (const [folderName, groupCommands] of Object.entries(commandGroups)) {
			const folderPath = `Devices.${this.duid}.${folderName}`;
			try {
				await this.deps.ensureFolder(folderPath);
			} catch (e: unknown) {
				this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Failed to ensure commands folder ${folderPath}: ${this.deps.adapter.errorMessage(e)}`, "error");
				return;
			}

			for (const [command, commonCommand] of Object.entries(groupCommands)) {
				promises.push(this.processCommand(folderPath, command, commonCommand));
			}
		}

		try {
			await Promise.all(promises); // Wait for all operations
			this.commandsCreated = true; // Done
		} catch (e: unknown) {
			// Catch Promise.all errors (rare)
			this.deps.log.error(`[${this.duid}] Critical error during parallel command object creation: ${this.deps.adapter.errorMessage(e)}`);
		}
	}

	/**
	 * Process a single command object creation.
	 */
	protected async processCommand(folderPath: string, cmd: string, spec: CommandSpec | any): Promise<void> {
		try {
			const options: Partial<ioBroker.StateCommon> = {
				...(spec as Partial<ioBroker.StateCommon>),
				name: spec.name || this.deps.adapter.translations[cmd] || cmd, // Add name generation
				write: true, // Writable
			};
			const originalType = spec.type; // Store original type

			// Determine Role
			if (!options.role) {
				if (originalType === "boolean" && !options.states) options.role = "button";
				else if (originalType === "number" && options.states) options.role = "value.list";
				else if (originalType === "number") options.role = "level";
				else if (originalType === "json" && options.states) options.role = "value.list";
				else if (originalType === "json") options.role = "json";
				else options.role = "state";
			}

			// Enforce default value if missing (User requirement: no null defaults)
			if (options.def === undefined || options.def === null) {
				if (options.type === "boolean" || options.role === "button") {
					options.def = false;
				} else if (options.type === "number") {
					options.def = options.min ?? 0;
				} else if (options.type === "string") {
					options.def = "";
				}
			}

			// Adjust type
			if (originalType === "json") {
				options.type = "string";
			}

			// Type validation and default
			const validTypes: ioBroker.CommonType[] = ["string", "number", "boolean", "object", "array", "mixed"];
			if (!options.type || typeof options.type !== "string" || !validTypes.includes(options.type as ioBroker.CommonType)) {
				if (originalType !== "json") {
					// Skip log if setting to string
					this.deps.log.warn(`[${this.duid}] Invalid or missing type '${spec.type}' for command '${cmd}', defaulting to 'string'.`);
				}
				options.type = "string";
			}

			const path = `${folderPath}.${cmd}`;

			// Create/Update Object
			const existingObj = await this.deps.adapter.getObjectAsync(path);
			if (existingObj) {
				// Extend if common differs. Stringify is good enough for now.
				// Goes through applyCommonUpdate because a command's picker can shrink - a water or
				// suction level the robot turns out not to have is removed from `common.states`,
				// and a plain extendObject would leave it standing on every existing installation.
				if (JSON.stringify(existingObj.common) !== JSON.stringify(options)) {
					await this.deps.adapter.applyCommonUpdate(path, existingObj, options as ioBroker.StateCommon);
				}
			} else {
				await this.deps.ensureState(path, options as ioBroker.StateCommon);
			}

			// Reset button states
			if (options.role === "button" && options.type === "boolean") {
				const currentState = await this.deps.adapter.getStateAsync(path);
				// Reset to false if needed
				if (!currentState || currentState.val !== false) {
					await this.deps.adapter.setState(path, false, true);
				}
			}
		} catch (e: unknown) {
			this.deps.log.error(`[${this.duid}] Error processing command object '${cmd}': ${this.deps.adapter.errorMessage(e)}`);
		}
	}

	// --- Helper Methods ---

	/**
	 * Adds/updates command definition. Merges states to preserve specifics.
	 * @param name Command name.
	 * @param spec CommandSpec definition.
	 */
	protected addCommand(name: string, spec: CommandSpec | any, group = "commands"): void {
		if (!name || typeof name !== "string") {
			this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `addCommand: Invalid command name provided: ${name}`, "error");
			return;
		}
		try {
			let targetGroup = this.commands;
			if (group !== "commands") {
				if (!this.extraCommandGroups[group]) {
					this.extraCommandGroups[group] = {};
				}
				targetGroup = this.extraCommandGroups[group];
			}
			// Merge states if new spec has fewer states.
			if (targetGroup[name]?.states && spec.states) {
				const existingStatesJson = JSON.stringify(targetGroup[name].states);
				const newStatesJson = JSON.stringify(spec.states);
				if (existingStatesJson !== newStatesJson) {
					// Merge: New states overwrite/add
					spec.states = { ...targetGroup[name].states, ...spec.states };
				} else {
					// Preserve existing spec if states identical
					spec = { ...targetGroup[name], ...spec, states: targetGroup[name].states };
				}
			} else if (targetGroup[name]?.states && !spec.states) {
				// Keep existing states if new one has none
				spec.states = targetGroup[name].states;
			}
			targetGroup[name] = spec;
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Error in addCommand for '${name}': ${this.deps.adapter.errorMessage(e)}`, "error");
		}
	}

	public getCommandFolders(): string[] {
		return ["commands", ...Object.keys(this.extraCommandGroups)];
	}

	public hasCommandFolder(folder: string): boolean {
		return folder === "commands" || Object.prototype.hasOwnProperty.call(this.extraCommandGroups, folder);
	}

	public getCommandSpec(folder: string, command: string): CommandSpec | any | undefined {
		if (folder === "commands") {
			return this.commands[command];
		}

		return this.extraCommandGroups[folder]?.[command];
	}

	/**
	 * Takes a command away after the robot said it does not know it.
	 *
	 * ## Why a control is removed rather than left standing
	 *
	 * `unknown_method` is the robot answering a question about itself, and the answer is final for
	 * this firmware. Leaving the control there produces exactly the failure this project has been
	 * removing since the eight dead switches of round 2: a button that looks like it works, fails on
	 * every press, and writes a red mark that the user learns to ignore. The reported case is the
	 * drying pair of the test device - offered because the dock reports `dry_status`, rejected by the
	 * firmware because the commands do not exist in its plugin at all.
	 *
	 * Both halves are needed, and neither alone is enough:
	 *
	 * - the **spec** goes, or `getCommandParams` would keep building the request;
	 * - the **object** goes, or the admin tab keeps offering it - the tab decides what to show from
	 *   the objects that exist (`src-tab/src/engine/MapEngine.ts`, `populateDock`), which is how a
	 *   leftover object turns into `Unregistered command …` on the next press.
	 *
	 * ## Why it is not remembered across restarts
	 *
	 * For the same reason `CapabilityProbe` does not persist its verdicts: a firmware update can add
	 * a capability, and a stored "no" would outlive the reason for it. A command that comes back on
	 * the next adapter start costs one rejected press; a wrong "no" that nobody can clear costs the
	 * function. Where the adapter already knows better - the drying switch above - the command is not
	 * offered again in the first place.
	 *
	 * @param command Command as it is registered, i.e. what the user pressed.
	 * @returns The folder it was removed from, or null when there was nothing to remove.
	 */
	public async retireUnsupportedCommand(command: string): Promise<string | null> {
		for (const folder of this.getCommandFolders()) {
			const group = folder === "commands" ? this.commands : this.extraCommandGroups[folder];
			if (!group || !Object.prototype.hasOwnProperty.call(group, command)) continue;

			delete group[command];

			const path = `Devices.${this.duid}.${folder}.${command}`;
			try {
				if (typeof this.deps.adapter.delObjectAsync === "function") {
					await this.deps.adapter.delObjectAsync(path);
				}
			} catch (e: unknown) {
				// The spec is gone either way, so the command can no longer be sent. A leftover object
				// is a cosmetic problem next to that, and failing here would undo nothing.
				this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined,
					`Could not remove the object of the unsupported command '${command}': ${this.deps.adapter.errorMessage(e)}`, "warn");
			}

			this.deps.adapter.rLog("System", this.duid, "Info", undefined, undefined,
				`The robot answered '${command}' with '${UNKNOWN_METHOD_ANSWER}', so it does not have this function. Removed ${path}; it is offered again after an adapter restart.`, "info");
			return folder;
		}

		return null;
	}

	/**
	 * Calls injected ensureState with correct path.
	 * @param subfolder Subfolder name.
	 * @param stateName State name.
	 * @param commonOptions State options.
	 * @param native Optional native options.
	 */
	protected async ensureState(subfolder: string, stateName: string, commonOptions: Partial<ioBroker.StateCommon>, native: Record<string, any> = {}): Promise<void> {
		const path = `Devices.${this.duid}.${subfolder}.${stateName}`;
		try {
			// Validate type before ensureState
			const validTypes: ioBroker.CommonType[] = ["string", "number", "boolean", "object", "array", "mixed"];
			if (commonOptions.type && !validTypes.includes(commonOptions.type as ioBroker.CommonType)) {
				this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Invalid type '${commonOptions.type}' in ensureState for ${path}, defaulting to 'string'.`, "warn");
				commonOptions.type = "string";
			}

			// Check if object exists and needs update
			const existingObj = await this.deps.adapter.getObjectAsync(path);
			if (existingObj && existingObj.common && this.hasStatesChanged(commonOptions.states, existingObj.common.states)) {
				this.deps.log.debug(`[${this.duid}] Updating object definition for ${path} (states mapping changed)`);
				await this.deps.adapter.extendObject(path, {
					common: commonOptions as ioBroker.StateCommon,
					native: native
				});
				return;
			}

			// Standard ensure (creates if not exists)
			await this.deps.ensureState(path, commonOptions as ioBroker.StateCommon, native); // Cast after validation
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Error", undefined, undefined, `Error in ensureState for ${path}: ${this.deps.adapter.errorMessage(e)}`, "error");
		}
	}

	// --- Static Methods ---

	/**
	 * Get registered feature class for model.
	 * @param modelId Robot model identifier.
	 * @returns Constructor or undefined.
	 */
	public static getRegisteredModelClass(modelId: string): FeatureClassConstructor | undefined {
		return modelRegistry.get(modelId);
	}

	/**
	 * Get all registered model IDs.
	 */
	public static getRegisteredModels(): string[] {
		return Array.from(modelRegistry.keys());
	}

	/**
	 * Check if static feature is defined.
	 * @param feature Feature enum key.
	 */
	public hasStaticFeature(feature: Feature): boolean {
		return this.config.staticFeatures.includes(feature);
	}

	public hasFeature(feature: Feature): boolean {
		return this.appliedFeatures.has(feature) || this.config.staticFeatures.includes(feature);
	}

	/**
	 * Helper to safely access dynamic feature methods.
	 * Encapsulates type casting for readability.
	 */
	protected getFeatureMethod(name: string): Function {
		// Safe access using keyof assertion
		const method = this[name as keyof this];
		if (typeof method === "function") {
			return method as Function;
		}
		throw new Error(`Feature method '${name}' not found or is not a function.`);
	}

	// --- Command Parameter Interception ---

	/**
	 * Allows feature handlers to provide/modify parameters for a command before sending.
	 * Override this to implement logic like 'app_segment_clean' gathering segments from states.
	 * @param method Command method name.
	 * @param params Existing parameters passed from caller.
	 */
	public async getCommandParams(method: string, params?: unknown, id?: string): Promise<unknown> {
		void method;
		void id;
		return params;
	}

	public async onCommandResult(requestedMethod: string, finalMethod: string, response: unknown, params?: unknown): Promise<void> {
		void requestedMethod;
		void finalMethod;
		void response;
		void params;
	}

	// --- Data Update Methods (Unified Data Handling) ---

	/**
	 * Fetch data and store in folder.
	 *
	 * Handles all three answer shapes a Roborock getter produces, because only one of them used to
	 * arrive. Everything else was dropped without a word - see {@link processNonObjectResult}.
	 * @param method API method.
	 * @param params API parameters.
	 * @param folder Target folder.
	 * @param mapper Optional data mapper. Applies to object answers only; an array or a scalar has
	 *   no keys to map, and inventing some would be the guess this whole path exists to avoid.
	 */
	protected async requestAndProcess(method: string, params: any[], folder: string, mapper?: (data: any) => Record<string, any> | Promise<Record<string, any>>): Promise<void> {
		try {
			const result = await this.deps.adapter.requestsHandler.sendRequest(this.duid, method, params);

			// Recursively unwrap single-element arrays (common in B01/Tuya responses)
			let unwrapped = result;
			while (Array.isArray(unwrapped) && unwrapped.length === 1) {
				unwrapped = unwrapped[0];
			}

			if (typeof unwrapped === "object" && unwrapped !== null && !Array.isArray(unwrapped)) {
				let resultObj = unwrapped as Record<string, unknown>;

				// Apply mapper
				if (mapper) {
					resultObj = await mapper(resultObj);
				}

				await this.deps.ensureFolder(`Devices.${this.duid}.${folder}`);

				for (const key in resultObj) {
					await this.processResultKey(folder, key, resultObj[key]);
				}
				return;
			}

			await this.processNonObjectResult(method, folder, unwrapped);
		} catch (e: unknown) {
			this.deps.adapter.rLog("System", this.duid, "Warn", undefined, undefined, `Failed to update ${folder} (method: ${method}): ${this.deps.adapter.errorMessage(e)}`, "warn");
		}
	}

	/**
	 * Publish an answer that is not an object - an array or a bare value.
	 *
	 * ## Why this exists
	 *
	 * `requestAndProcess` used to write states only when the answer unwrapped to a plain object.
	 * Everything else fell through to the end of the `try` block and vanished: no state, no log,
	 * no error.
	 *
	 * Measured against every answer the reference robot gives - all 43 of them, recorded in
	 * `_appanalysis/19-geraetefaehigkeiten.md` §2 - **28 arrived and 15 were dropped**. The three
	 * shapes that got lost, with a real example each:
	 *
	 * | Shape | Example answer | What used to happen |
	 * | --- | --- | --- |
	 * | bare value in a wrapper | `get_sound_volume` → `[90]` | unwrapped to `90`, then nothing |
	 * | list | `get_fw_features` → `[111,…,125]` | nothing |
	 * | empty list | `get_timer` → `[]` | nothing - indistinguishable from "did not answer" |
	 *
	 * **What this is not:** a claim that eight states are missing today. Of the eight base callers,
	 * `get_prop`, `get_consumable`, `get_network_info` and `get_multi_maps_list` answer with an
	 * object and always worked; V1 overrides `updateTimers` and `updateRoomMapping` with its own
	 * parsers; and `Feature.FirmwareInfo` and `Feature.Timers` are granted by **no** model class,
	 * so those two return before ever reaching this code. That gate is a separate finding and is
	 * deliberately not touched here.
	 *
	 * What is broken is the mechanism: any getter whose answer is not an object loses its value
	 * without a word - which is precisely the mechanism needed to publish values the adapter has
	 * no name for.
	 *
	 * ## The rules, and what they deliberately do not do
	 *
	 * - **Bare value** (`[101]` → `101`, `["Europe/Berlin"]` → `"Europe/Berlin"`): one state, typed
	 *   after the value.
	 * - **Array** (`[]`, `[111,…]`, `[[16,…],…]`): one state holding the JSON, `common.type`
	 *   `"array"`. An empty array is written as `[]` rather than skipped, because "answered, and
	 *   the list is empty" and "did not answer" are different facts and the user has no other way
	 *   to tell them apart.
	 * - **Nothing at all** (`null`/`undefined`): no state, but a log line. Silence was the defect.
	 *
	 * The state carries a name and a type and nothing else - no role beyond the default, no unit,
	 * no `states` list. That is on purpose: none of those can be derived from a value, and a
	 * guessed unit is worse than none. They come from the mode tables instead
	 * (`lib/protocols/roborock_value_lists.json`, `scripts/extract_appplugin_value_lists.js`).
	 *
	 * **Read-only, without exception.** A writable state whose range nobody knows is exactly what
	 * this project has refused four times over: `save_map` drops every zone not sent with it
	 * (`_appanalysis/14-editor-methoden.md` §2.1), `WashTowelModeMap` jumps 2 → 8 → 10, and the
	 * robot acknowledges an out-of-range value with `["ok"]` before discarding it. Nothing here
	 * sets `write`, and `ensureState` defaults it to `false`.
	 * @param method The method that produced the answer; supplies the state name.
	 * @param folder Target folder.
	 * @param value The unwrapped answer.
	 */
	protected async processNonObjectResult(method: string, folder: string, value: unknown): Promise<void> {
		if (value === undefined || value === null) {
			this.deps.adapter.rLog("System", this.duid, "Debug", undefined, undefined, `${method} answered without data, nothing written to ${folder}`, "debug");
			return;
		}

		await this.deps.ensureFolder(`Devices.${this.duid}.${folder}`);
		await this.processResultKey(folder, resultStateKeyForMethod(method), value);
	}

	/**
	 * Process a single key from API result.
	 */
	protected async processResultKey(folder: string, key: string, val: unknown): Promise<void> {
		// Determine common options (type, role, unit)
		let common: Partial<ioBroker.StateCommon> | undefined;
		if (folder === "deviceStatus") {
			common = this.getCommonDeviceStates(key);
		} else if (folder === "cleaningInfo") {
			common = this.getCommonCleaningInfo(key);
		} else if (folder === "cleaningRecords" || folder.includes("records")) {
			common = this.getCommonCleaningRecords(key);
		}

		if (!common) {
			// `typeof []` is "object", which mislabels every list. ioBroker has "array" for exactly
			// this and both are stored as a JSON string, so the distinction costs nothing.
			const derivedType: ioBroker.CommonType = Array.isArray(val) ? "array" : (typeof val as ioBroker.CommonType);
			common = { name: key, type: derivedType, read: true, write: false };
			if (derivedType === "array" || derivedType === "object") {
				common.role = "json";
			}
		}

		// Handle Objects/Arrays by stringifying them so they don't crash the state
		if (typeof val === "object" && val !== null) {
			val = JSON.stringify(val);
		}

		// Formatting for timestamp keys only (clean_finish is 0/1 flag, not a timestamp)
		if ((key === "last_clean_t" || key === "begin" || key === "end") && typeof (val as any) === "number") {
			val = new Date((val as number) * 1000).toLocaleString();
			common.type = "string"; // Update type to match new value
		}

		// Enforce type matching to keep the log clean
		if (common.type === "string" && typeof val !== "string") {
			val = String(val);
		} else if (common.type === "number" && typeof val !== "number") {
			val = Number(val);
		} else if (common.type === "boolean" && typeof val !== "boolean") {
			val = !!val;
		}

		const fullPath = `Devices.${this.duid}.${folder}.${key}`;

		if (!this.createdStates.has(fullPath)) {
			await this.deps.ensureState(fullPath, common);
			this.createdStates.add(fullPath);
		}

		await this.deps.adapter.setStateChanged(fullPath, { val: val as ioBroker.StateValue, ack: true });
	}

	// --- Helper Methods ---

	private hasStatesChanged(
		newStates: Record<string, string> | string | string[] | undefined,
		oldStates: Record<string, string> | string | string[] | undefined
	): boolean {
		if (!!newStates !== !!oldStates) return true; // One is defined, one is not
		if (!newStates || !oldStates) return false; // Both undefined
		return JSON.stringify(newStates) !== JSON.stringify(oldStates);
	}

	public async updateStatus(): Promise<void> {
		// Default for vacuums
		await this.requestAndProcess("get_prop", ["get_status"], "deviceStatus");
	}

	public async updateConsumables(): Promise<void> {
		if (!this.hasFeature(Feature.Consumables)) return;
		await this.requestAndProcess("get_consumable", [], "consumables");
	}

	public async updateNetworkInfo(): Promise<void> {
		// No feature guard: get_network_info is supported on all devices (V1/MQTT); B01 overrides and uses service.get_net_info.
		await this.requestAndProcess("get_network_info", [], "networkInfo");
	}

	public async updateTimers(): Promise<void> {
		if (!this.hasFeature(Feature.Timers)) return;
		await this.requestAndProcess("get_timer", [], "timers");
		await this.requestAndProcess("get_server_timer", [], "timers");
	}

	public async updateFirmwareFeatures(): Promise<void> {
		if (!this.hasFeature(Feature.FirmwareInfo)) return;
		await this.requestAndProcess("get_fw_features", [], "firmwareFeatures");
	}

	public async updateMultiMapsList(): Promise<void> {
		if (!this.hasFeature(Feature.MultiMap)) return;
		await this.requestAndProcess("get_multi_maps_list", [], "map");
	}

	public async updateRoomMapping(): Promise<void> {
		if (!this.hasFeature(Feature.RoomMapping)) return;
		await this.requestAndProcess("get_room_mapping", [], "map");
	}

	// Complex updates (override in subclasses)
	public async updateCleanSummary(): Promise<void> {
		// Default: no-op
	}

	public async updateMap(): Promise<void> {
		// Default: no-op
	}

	public async updateExtraStatus(): Promise<void> {
		// Default: no-op. Override for model-specifics.
	}

	public getCurrentMapIndex(): number {
		return 0;
	}

	public async getPhoto(imgId: string, type: number): Promise<any> {
		if (!this.hasFeature(Feature.GetPhoto)) {
			throw new Error("getPhoto feature not enabled for this device");
		}

		try {
			const res = (await this.deps.adapter.requestsHandler.sendRequest(
				this.duid,
				"get_photo",
				{
					data_filter: {
						img_id: imgId,
						type: type,
					},
				}
			)) as any;
			// PhotoManager handles the async 300/301 packets and resolves the promise with the final image.
			// The data returned here is the result of that resolution.
			// If the robot supports encryption (Cipher 1), PhotoManager now automatically handles RSA/AES decryption.
			const responseData = (res as any).buffer ? res : (res as any).data || res;

			return responseData;
		} catch (e: unknown) {
			this.deps.adapter.rLog("Requests", this.duid, "Error", this.protocolVersion || undefined, undefined, `[getPhoto] Failed: ${this.deps.adapter.errorMessage(e)}`, "error");
			throw e;
		}
	}

	// --- Instance Getters for Constants (Abstract Declarations) ---
	// Implemented by subclasses to provide constants.

	public abstract getCommonConsumable(attribute: string | number): Partial<ioBroker.StateCommon> | undefined;
	public abstract isResetableConsumable(consumable: string): boolean;
	public abstract getCommonDeviceStates(attribute: string | number): Partial<ioBroker.StateCommon> | undefined;
	public abstract getCommonCleaningRecords(attribute: string | number): Partial<ioBroker.StateCommon> | undefined;
	public abstract getFirmwareFeatureName(featureID: string | number): string;
	public abstract getCommonCleaningInfo(attribute: string | number): Partial<ioBroker.StateCommon> | undefined;
}
