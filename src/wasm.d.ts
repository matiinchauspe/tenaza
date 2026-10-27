/**
 * `import … from "*.wasm" with { type: "file" }` (ticket 03, decision 02):
 * Bun's own loader for this import attribute hands back the resolved path
 * to the file — the real path on disk under `bun run`/`bun test`, or the
 * embedded asset's virtual path once the grammar is compiled into the
 * binary (`bun build --compile`) — never the file's bytes. Declared here
 * because `bun-types/extensions.d.ts` only covers the DEFAULT loader for a
 * handful of extensions (`.txt`, `.toml`, …), none of them `.wasm`, and
 * none of them this import attribute's own shape.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
