/**
 * Local-directory plugin entrypoint.
 *
 * OpenCode's loader resolves local directory plugins through file candidates
 * at the directory root (`server`, then `index`); a plain `exports` map alone
 * is not enough for directory-sourced plugins. This barrel exists so
 * `"plugins": ["<this folder>"]` resolves — the implementation lives in
 * `src/index.ts` and is also what the npm package exports.
 */
export { default } from "./src/index.ts"
