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
			/**
			 * Overridable, so two runs in the same checkout do not fight over one directory.
			 *
			 * vitest writes its per-worker coverage into `<reportsDirectory>/.tmp` and deletes that
			 * folder when it finishes. A second run starting meanwhile takes the first one's files
			 * with it, and the first dies with "Something removed the coverage directory" - a failure
			 * that says nothing about the code. That happens whenever someone runs a focused suite
			 * while the full gate is going, which in this project is routine.
			 *
			 * The default is unchanged, so CI and a plain `npm test` behave exactly as before.
			 */
			reportsDirectory: process.env.VITEST_COVERAGE_DIR || "./coverage"
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
