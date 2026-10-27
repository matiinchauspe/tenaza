import { createRoot } from "react-dom/client";
import { App } from "./App";

/**
 * No client-side cookie bootstrap here (ticket 08 fix, reverting a
 * regression): the token is validated and the cookie set SERVER-SIDE by
 * `GET /auth` (`daemon.ts`'s `authResponse`) before the browser ever lands
 * on this page — the launcher (`buildDaemonUrl`) opens `/auth?token=`, which
 * 302s here once the cookie is set. By the time this module runs, the
 * cookie is already an HttpOnly one the server set, or there wasn't a valid
 * token to begin with; this file has nothing to do with it either way.
 */
const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
