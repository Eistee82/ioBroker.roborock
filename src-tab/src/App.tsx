import React from "react";
import { StyledEngineProvider, ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { Box } from "@mui/material";
import {
	AdminConnection,
	GenericApp,
	I18n,
	Loader,
	type GenericAppProps,
	type GenericAppState,
	type IobTheme
} from "@iobroker/adapter-react-v5";

import { MapView } from "./components/MapView";
import { createMapThemeReporter } from "./engine/mapThemeReporter";
import type { MapThemeName } from "./engine/mapThemeReporter";
import { createRoborockTheme, themeCssVariables } from "./theme";
import { isDarkColour, themeFromName, themeFromQuery } from "./engine/adminTheme";

import enLang from "@i18n/en.json";
import deLang from "@i18n/de.json";
import esLang from "@i18n/es.json";
import frLang from "@i18n/fr.json";
import itLang from "@i18n/it.json";
import nlLang from "@i18n/nl.json";
import plLang from "@i18n/pl.json";
import ptLang from "@i18n/pt.json";
import ruLang from "@i18n/ru.json";
import ukLang from "@i18n/uk.json";
import zhCnLang from "@i18n/zh-cn.json";

interface AppState extends GenericAppState {
	/** True once the socket is up and the instance is known. */
	ready: boolean;
}

/**
 * The Roborock admin tab.
 *
 * `GenericApp` supplies the socket, the theme, the language and the instance. That is the
 * whole point of this rewrite: the page used to build all of that itself in `src/www/conn.ts`,
 * including a three second "no answer from server" timer that reloaded the page in a loop.
 */
export default class App extends GenericApp<GenericAppProps, AppState> {
	constructor(props: GenericAppProps) {
		super(props, {
			// @ts-expect-error the settings type declares an instance, not the class
			Connection: AdminConnection,
			translations: {
				en: enLang,
				de: deLang,
				es: esLang,
				fr: frLang,
				it: itLang,
				nl: nlLang,
				pl: plLang,
				pt: ptLang,
				ru: ruLang,
				uk: ukLang,
				"zh-cn": zhCnLang
			},
			// A tab has nothing to save, so the Save/Close bar of a config dialog is out of place.
			bottomButtons: false,
			doNotLoadAllObjects: true
		});

		this.state = { ...this.state, ready: false };
	}

	onConnectionReady(): void {
		this.setState({ ready: true });
		this.applyThemeToDocument();
		this.publishMapTheme();
		// A theme switch in the admin writes the key from another window, which fires `storage`
		// here. `GenericApp` waits for an `updateTheme` message instead, and that does not reach
		// every tab - then the page keeps the mode it was opened with until it is reloaded.
		window.addEventListener("storage", this.onThemeStorage);
	}

	componentWillUnmount(): void {
		window.removeEventListener("storage", this.onThemeStorage);
	}

	/**
	 * Re-renders when the admin stores a different theme.
	 * @param event Storage event; ignored unless it concerns the theme key.
	 */
	private onThemeStorage = (event: StorageEvent): void => {
		if (event.key && event.key !== "App.themeName") return;
		this.forceUpdate();
	};

	componentDidUpdate(): void {
		this.applyThemeToDocument();
		this.publishMapTheme();
	}

	/**
	 * Gate that turns "the theme on every render" into "the theme when it changed".
	 * See {@link createMapThemeReporter} for why only changes may be sent.
	 */
	private readonly reportMapTheme = createMapThemeReporter((theme: MapThemeName) => {
		void this.socket
			?.sendTo(`${this.adapterName}.${this.instance}`, "set_map_theme", { theme })
			.catch(() => {
				// An adapter without the command answers with an error. The map then stays light,
				// which is exactly what it was before - not worth bothering the user with, and
				// retrying would only repeat the same answer.
			});
	});

	/**
	 * Tells the adapter which theme this browser is showing.
	 *
	 * The map is not drawn here: it is a PNG the adapter renders and this page merely displays,
	 * so the adapter is the only place that can paint it dark - and it has no way of knowing what
	 * the browser looks like unless the browser says so. Whether the report is acted on is the
	 * adapter's decision; with a fixed colour scheme configured it is simply remembered.
	 */
	private publishMapTheme(): void {
		if (!this.socket) return;
		this.reportMapTheme(createRoborockTheme(this.resolveTheme()).palette.mode === "dark" ? "dark" : "light");
	}

	/**
	 * Writes the theme variables onto the document root and paints the page itself.
	 *
	 * They used to sit on a `Box` inside the app, which is not enough for two reasons. MUI renders
	 * tooltips, menus and dialogs through a portal into `document.body` - outside that Box, where
	 * the variables do not reach, so those parts kept light-mode colours in a dark admin. And
	 * `html`/`body` carried no themed background at all: whatever the app does not cover stayed
	 * white, which in a dark admin is a bright frame around a dark page.
	 *
	 * Setting them on `documentElement` covers both, portals included, because everything in the
	 * document inherits from there.
	 */
	private applyThemeToDocument(): void {
		const theme = createRoborockTheme(this.resolveTheme());
		const root = document.documentElement;

		for (const [name, value] of Object.entries(themeCssVariables(theme))) {
			root.style.setProperty(name, value);
		}

		// The page behind the app, for the moment before React paints and for anything it does
		// not cover. `color-scheme` additionally hands the mode to the browser, so the parts it
		// draws itself - scrollbars above all - follow along.
		const ground = theme.palette.background.default;
		root.style.setProperty("color-scheme", theme.palette.mode);
		root.style.backgroundColor = ground;
		document.body.style.backgroundColor = ground;
	}

	/**
	 * The theme to draw with, corrected against the admin the tab is embedded in.
	 *
	 * `GenericApp` reads the mode once from `localStorage['App.themeName']` and then listens for an
	 * `updateTheme` message. Inside an admin tab that is not always enough: the tab is an iframe
	 * whose document is loaded from `/adapter/roborock/tab.html`, and a tab opened before the admin
	 * has written that key - or one whose message never arrives - keeps the light default while the
	 * admin around it is dark.
	 *
	 * So the value is checked against the surrounding window, which is the admin itself and the
	 * authority on its own theme. Reading across frames is allowed here because both documents come
	 * from the same origin; a foreign origin throws, and then the value stays as it was.
	 * @returns The base theme, with the mode corrected when the admin disagrees.
	 */
	private resolveTheme(): IobTheme {
		const own = this.state.theme;
		const admin = readAdminThemeName();
		if (!admin) return own;

		const adminIsDark = admin === "dark";
		if (adminIsDark === (own.palette.mode === "dark")) return own;

		// `GenericApp.createTheme` builds the very theme it would have built itself, so the
		// correction stays inside the framework's own palettes rather than inventing one.
		return this.createTheme(admin) as IobTheme;
	}

	render(): React.JSX.Element {
		// The admin decides light or dark; the Roborock palette is layered on top of that choice.
		const theme: IobTheme = createRoborockTheme(this.resolveTheme());

		if (!this.state.loaded || !this.state.ready) {
			return (
				<StyledEngineProvider injectFirst>
					<ThemeProvider theme={theme}>
						{/*
						 * `CssBaseline` belongs here and not only below: it is what paints the document
						 * body in the theme's colour. Without it the tab shows the browser's white page
						 * until the socket is up, which in a dark admin is a bright flash on every open.
						 * `enableColorScheme` additionally hands the mode to the browser, so the parts
						 * it draws itself - scrollbars above all - turn dark with the rest.
						 */}
						<CssBaseline enableColorScheme />
						<Loader themeType={this.state.themeType} />
					</ThemeProvider>
				</StyledEngineProvider>
			);
		}

		return (
			<StyledEngineProvider injectFirst>
				<ThemeProvider theme={theme}>
					<CssBaseline enableColorScheme />
					<Box
						sx={{ width: "100%", height: "100%" }}
						style={themeCssVariables(theme)}
					>
						<MapView
							socket={this.socket}
							instanceId={`${this.adapterName}.${this.instance}`}
							language={I18n.getLanguage()}
						/>
					</Box>
				</ThemeProvider>
			</StyledEngineProvider>
		);
	}
}

/**
 * Reads the theme name the surrounding admin uses.
 *
 * Checked in the order of how authoritative each source is: the admin's own window first, then
 * this document's storage, then what the browser reports. Each step is guarded on its own -
 * reading `localStorage` of a cross-origin frame throws, and a tab must not go blank over a
 * colour.
 * @returns The theme name, or null when nothing could be read.
 */
function readAdminThemeName(): "dark" | "light" | null {
	const fromStorage = (target: Window | null): string | null => {
		try {
			return target?.localStorage?.getItem("App.themeName") ?? null;
		} catch {
			// Different origin, or storage disabled. Not an error worth a log line every render.
			return null;
		}
	};

	// The admin hands a tab its theme in the query string, and that is the only source that is
	// current by construction: it is written the moment the tab is opened. `GenericApp` parses the
	// same query but takes only `instance` and `newReact` out of it (see its constructor), so the
	// theme in there is dropped - which is why the classic HTML tabs of other adapters follow the
	// dark mode and this one did not.
	const fromQuery = themeFromQuery(window.location.search);
	if (fromQuery) return fromQuery;

	// `window.parent` is the window itself when the tab is not embedded, so this covers both.
	const parentName = window.parent !== window ? fromStorage(window.parent) : null;
	const name = parentName ?? fromStorage(window);
	const byName = themeFromName(name);
	if (byName) return byName;

	// Last resort, and the only source that cannot be out of date: look at the admin itself.
	//
	// Measured on a real installation - admin 7.0.25 with dark mode switched on - the stored
	// `App.themeName` said `light`. Whatever the admin does with its own setting, the page it
	// draws is the ground truth, and the tab sits inside it. So the background colour of the
	// surrounding document decides: a dark page means dark mode, whatever any key claims.
	//
	// Same-origin only, like the storage read above; a foreign origin throws and leaves the
	// resolved mode alone.
	try {
		const parentBody = window.parent !== window ? window.parent.document?.body : null;
		if (parentBody) {
			const background = window.parent.getComputedStyle(parentBody).backgroundColor;
			const dark = isDarkColour(background);
			if (dark !== null) return dark ? "dark" : "light";
		}
	} catch {
		// Cross-origin, or the admin has not painted yet. Nothing to correct.
	}

	// Deliberately no fall back to `prefers-color-scheme`. This value exists to *correct* what
	// GenericApp resolved, and the browser preference is not evidence about the admin: an admin
	// set to dark on a machine whose system is light would be turned light by it. Without any
	// usable source there is nothing to correct, so the caller keeps what it had.
	return null;
}

