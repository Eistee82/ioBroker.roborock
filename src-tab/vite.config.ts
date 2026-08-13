import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The tab runs inside the admin, so socket.io comes from the admin itself
 * (`admin/lib/js/socket.io.js`), not from the web adapter. The tag cannot live in the
 * source HTML because the file does not exist at build time and Vite would try to bundle it.
 */
function adminSocketIo(): Plugin {
	return {
		name: "roborock-admin-socket-io",
		transformIndexHtml: {
			order: "post",
			handler(html: string): string {
				return html.replace(
					"</head>",
					`    <script type="text/javascript" onerror="setTimeout(function(){window.location.reload()}, 5000)" src="./../../lib/js/socket.io.js"></script>\n</head>`
				);
			},
		},
	};
}

export default defineConfig({
	plugins: [react(), adminSocketIo()],
	// The admin serves the tab from `adapter/roborock/tab.html`, so every asset URL is relative.
	base: "./",
	resolve: {
		alias: {
			// Map maths, drawing and key helpers are shared with the adapter and stay there.
			"@adapter": fileURLToPath(new URL("../src", import.meta.url)),
			// One translation store for the whole adapter: the flat admin/i18n files.
			"@i18n": fileURLToPath(new URL("../admin/i18n", import.meta.url)),
		},
	},
	server: {
		port: 3000,
		fs: {
			// The shared adapter sources live outside this project root.
			allow: [fileURLToPath(new URL("..", import.meta.url))],
		},
	},
	build: {
		target: "chrome89",
		outDir: fileURLToPath(new URL("../admin", import.meta.url)),
		// admin/ holds hand-maintained files (jsonConfig.json, i18n, png) that must survive.
		emptyOutDir: false,
		assetsDir: "assets",
		rollupOptions: {
			input: fileURLToPath(new URL("./tab.html", import.meta.url)),
		},
	},
});
