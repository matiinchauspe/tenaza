import { createRoot } from "react-dom/client";
import { App } from "./App";

/**
 * No client-side cookie bootstrap: the token is validated and the cookie
 * set SERVER-SIDE by `GET /auth` (`daemon.ts`'s `authResponse`) before the
 * browser ever lands here — the launcher opens `/auth?token=`, which 302s
 * here once the cookie is set. By the time this module runs, the cookie is
 * already set, or there wasn't a valid token to begin with.
 */
const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
