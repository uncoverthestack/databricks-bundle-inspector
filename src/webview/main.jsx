import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Bootstrap from "./Bootstrap";
import "./index.css";

// main.jsx is the Vite entry point. It only mounts the app — no component
// definitions here so that Fast Refresh works correctly on Bootstrap and App.
const container = document.getElementById("root");

if (container) {
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <Bootstrap />
    </StrictMode>,
  );
}
