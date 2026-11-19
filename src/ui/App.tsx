import { BoardApp } from "./board/BoardApp";

/** The app's composition root: a future feature mounts beside the board here, not inside `board/`. */
export function App() {
  return <BoardApp />;
}
