import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Test setup of the React admin tab.
 *
 * This is deliberately a **second** vitest project, separate from the adapter's `vitest.config.ts`
 * in the repository root:
 *
 *  - The tab needs a DOM (`jsdom`) and the JSX transform, the adapter needs neither and must keep
 *    running in a plain node environment.
 *  - React, MUI and `@iobroker/adapter-react-v5` are installed in `src-tab/node_modules`, not in the
 *    root project, so the resolver has to run from here.
 *
 * The root config keeps excluding `src-tab/**` for exactly that reason; `npm run test:tab` starts
 * this one, and `npm test` runs both.
 */
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: [
			// `@iobroker/adapter-react-v5` is a barrel that re-exports the whole admin component
			// library - ObjectBrowser, FileBrowser, react-icons, Sentry. The production build
			// tree-shakes all of it away, but a test run loads the entire graph: measured at ~40 s
			// per run against ~1.6 s without it.
			//
			// Every component the tests touch imports exactly one thing from that package, `I18n`,
			// so the tests resolve it straight to the module it actually lives in. This is the same
			// class from the same package, only reached without the detour. Should a component ever
			// import something else from the barrel, the test fails with a missing-export error
			// rather than passing quietly - the shortcut cannot hide a change.
			{
				find: /^@iobroker\/adapter-react-v5$/,
				replacement: fileURLToPath(
					new URL("./node_modules/@iobroker/adapter-react-v5/build/i18n.js", import.meta.url),
				),
			},
			// Same aliases as `vite.config.ts` - a test that resolved `@adapter` differently from
			// the build would prove nothing about the shipped bundle.
			{ find: "@adapter", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
			{ find: "@i18n", replacement: fileURLToPath(new URL("../admin/i18n", import.meta.url)) },
		],
	},
	test: {
		globals: false,
		environment: "jsdom",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		setupFiles: ["./test/setup.ts"],
		reporters: ["default"],
		coverage: {
			provider: "v8",
			reporter: ["text"],
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
			reportsDirectory: "./coverage",
		},
	},
});
