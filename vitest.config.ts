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
		reporters: ["default"],
		silent: false,
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		exclude: ["node_modules", "dist", ".idea", ".git", ".cache", "build", "src-tab/**"]
	},
});
