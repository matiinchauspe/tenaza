import { BoardApp } from "./board/BoardApp";

/** The app's composition root. The board is the whole page today (decision 04); a future feature mounts beside it here, not inside `board/`. */
export function App() {
  return <BoardApp />;
}
