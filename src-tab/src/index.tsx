import React from "react";
import { createRoot } from "react-dom/client";
import "@iobroker/adapter-react-v5/index.css";
import "./styles.css";
import App from "./App";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Missing #root element");
}

createRoot(container).render(
	<React.StrictMode>
		<App
			adapterName="roborock"
			bottomButtons={false}
		/>
	</React.StrictMode>
);
