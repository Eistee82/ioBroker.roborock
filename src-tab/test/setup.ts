/**
 * Shared setup for the tab's DOM tests.
 *
 * Two things the components take for granted in the admin but jsdom does not provide:
 *
 *  - **Translations.** Every label goes through `I18n.t`. With an empty dictionary `I18n.t`
 *    returns the key, so a render test would happily pass on a component that shows
 *    `ui_start` to the user. Loading the adapter's real `admin/i18n/en.json` means the
 *    assertions read the wording a user actually sees, and a key that was never translated
 *    shows up as a failure instead of as a plausible-looking string.
 *  - **`matchMedia`.** MUI's responsive helpers call it; jsdom has no implementation.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { I18n } from "@iobroker/adapter-react-v5";
import en from "@i18n/en.json";
import de from "@i18n/de.json";

I18n.setTranslations({ en: en as Record<string, string>, de: de as Record<string, string> });
I18n.setLanguage("en");
// The tab is not running in the admin here, so every lookup would be reported as missing.
I18n.disableWarning(true);

if (!window.matchMedia) {
	window.matchMedia = (query: string): MediaQueryList =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
}

afterEach(() => {
	cleanup();
});
