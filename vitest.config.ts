import { defineConfig } from "vitest/config";

/**
 * Adapter tests. The React tab is **not** part of this run and must not be: it needs a DOM and the
 * JSX transform, and its React, MUI and adapter-react-v5 copies live in `src-tab/node_modules`.
 * It has its own suite in `src-tab/vitest.config.ts`, reachable as `npm run test:tab`; `npm test`
 * and `npm run ci:check` run both.
 */
export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["src/**/*.test.ts", "src/lib/mock/**", "src-tab/**", "**/*.d.ts"],
			enabled: true,
			include: ["src/**/*.ts"],
			reportsDirectory: "./coverage"
		},
		typecheck: {
			enabled: true,
			checker: "tsc"
		},
		/**
		 * Well above vitest's 5 s default, because a handful of tests import `src/main.ts`.
		 *
		 * That import pulls the whole adapter in - every feature class, every service, the map
		 * pipelines - and it is transformed on the fly. On a loaded machine that alone takes several
		 * seconds before the test body starts, so those tests failed with "Test timed out in 5000ms"
		 * while passing every time they were run on their own. A timeout that depends on how busy the
		 * machine is does not test anything; it just makes the suite lie at random.
		 *
		 * This is deliberately not a fix for a slow test. Nothing here is expected to need 30 s - the
		 * slowest real test is `MapEditService`'s retry polling at about 6 s, and that one waits on
		 * purpose. The limit exists so that import time under load cannot be mistaken for a defect.
		 */
		testTimeout: 30_000,
		hookTimeout: 30_000,
		reporters: ["default"],
		silent: false,
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["node_modules", "dist", ".idea", ".git", ".cache", "build", "src-tab/**"]
	},
});
