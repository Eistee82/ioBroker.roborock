import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * ESLint for the React admin tab.
 *
 * The repository root has its own config built on `@iobroker/eslint-config`, and it deliberately
 * ignores `src-tab/**`. Those rules are written for adapter code that runs in node: they declare
 * the node globals rather than the browser ones and require a JSDoc block with a `@param` per
 * argument on every function. Pointed at JSX that produces pure noise - a destructured props
 * object turns into demands for `@param root0.parts` and the like, one per prop, and none of it
 * says anything about the component.
 *
 * So the tab lints itself, against the rules that do apply to it: the TypeScript recommendations,
 * the React and Hooks rules, and the browser globals. `npm run lint` in the root calls this one
 * too, so a single command still checks the whole repository.
 */
export default tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**", "coverage/**", "../admin/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.es2022,
			},
			parserOptions: {
				ecmaFeatures: { jsx: true },
			},
		},
		settings: {
			react: { version: "detect" },
		},
		plugins: {
			react,
			"react-hooks": reactHooks,
		},
		rules: {
			...react.configs.flat.recommended.rules,
			...react.configs.flat["jsx-runtime"].rules,
			...reactHooks.configs.recommended.rules,

			// The tab is compiled by TypeScript; prop types are the interface next to the component
			// and a second runtime description of them would only ever drift.
			"react/prop-types": "off",

			// An unused argument that is only there to reach a later one is a signature, not a bug.
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

			// d3 binds `this` to the DOM node inside `.each(function () { … })`, so a renderer that
			// wants that node in a later arrow callback has to capture it first. That is d3's
			// calling convention, not a stray alias, and the alternative would be rewriting the
			// drawing code to fight the library.
			"@typescript-eslint/no-this-alias": ["error", { allowedNames: ["el"] }],

			// The d3 selections and the ioBroker socket payloads are genuinely untyped at the edge.
			// Flagging every one of them would bury the findings that matter; `typecheck:tab` still
			// holds the rest of the file to `strict`.
			"@typescript-eslint/no-explicit-any": "off",

			// Matches the rest of the repository.
			eqeqeq: ["error", "always", { null: "ignore" }],
			"no-var": "error",
			"prefer-const": "error",
			"no-console": ["warn", { allow: ["warn", "error"] }],
		},
	},
	{
		// The build and test configs run in node, not in the browser.
		files: ["vite.config.ts", "vitest.config.ts", "test/**/*.ts"],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	{
		files: ["**/*.test.ts", "**/*.test.tsx", "test/**/*.ts"],
		rules: {
			// Tests reach into shapes on purpose to build fixtures.
			"@typescript-eslint/no-non-null-assertion": "off",
		},
	},
);
