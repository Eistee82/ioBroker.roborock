// src/lib/types.d.ts

// This file extends the default ioBroker types with your specific adapter configuration.
// It allows TypeScript to understand "this.config.username", "this.config.map_scale", etc.

declare global {
	namespace ioBroker {
		interface AdapterConfig {
			// Add all fields from your io-package.json "native" section here
			loginMethod: "email" | "password";
			username: string;
			password: string;
			/** Poll cadence (seconds) while the robot is idle/docked. */
			updateInterval: number;
			/** Poll cadence (seconds) while the robot is cleaning or moving. Clamped to 2..60. */
			activePollInterval?: number;
			/** Upper bound (seconds) of the exponential backoff after failed polls. Clamped to 30..900. */
			pollBackoffMaxInterval?: number;
			/**
			 * Cadence (seconds) of the live map update while the robot is working. 0 switches it
			 * off; any other value is clamped to 1..30 and doubled while the robot stands still.
			 */
			liveMapInterval?: number;

			enable_map_creation: boolean;
			cameraPin: string;
			hostname_ip?: string;
			forceRuntimeDetectEveryTime?: boolean;

			downloadRoborockImages?: boolean;
			sceneExecutionMode?: "local" | "cloud";
			region: "eu" | "us" | "cn" | "asia";
			/** Palette family for the room fills. Independent of `map_color_scheme`. */
			map_theme?: "dark" | "light";
			/**
			 * Colour set for the map surface (floor, walls, driven path). `auto` follows the theme
			 * the admin tab reports through the `mapTheme` state. Default `light`, which is the
			 * picture the adapter produced before this option existed.
			 */
			map_color_scheme?: "light" | "dark" | "auto";

			/** "cloud" = cloud + local (default), "local" = never contact the Roborock cloud. */
			connectionMode?: "cloud" | "local";
			/** JSON array of manually configured devices ({ duid, localKey, ip?, pv?, ... }). Secret. */
			manualDevices?: string;
			/** Listen for device broadcasts on UDP 58866. Off = static IPs only. */
			udpDiscoveryEnabled?: boolean;
			/** IP of the interface UDP 58866 binds to. Empty = all interfaces. */
			udpBindAddress?: string;
		}
	}
}

// This is required to make TypeScript treat this file as a module
export { };
