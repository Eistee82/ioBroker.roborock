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
import { createRoborockTheme, themeCssVariables } from "./theme";

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
	}

	render(): React.JSX.Element {
		// The admin decides light or dark; the Roborock palette is layered on top of that choice.
		const theme: IobTheme = createRoborockTheme(this.state.theme);

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
