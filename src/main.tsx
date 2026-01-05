import React from "react";
import ReactDOM from "react-dom/client";
import "./App.css"; // Ensure global styles (Tailwind variables) are loaded for all roots
import App from "./App";
import TranscribeFile from "./components/TranscribeFile";

// Initialize i18n
import "./i18n";

const urlParams = new URLSearchParams(window.location.search);
const windowType = urlParams.get("window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {windowType === "transcribe" ? <TranscribeFile /> : <App />}
  </React.StrictMode>,
);
