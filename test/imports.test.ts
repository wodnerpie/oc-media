import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

/**
 * OpenCode's plugin source watcher fingerprints the exact files a plugin
 * imports (`@opencode/plugin/source`). Non-exact relative specifiers like
 * `./x.js` point at files that don't exist (`x.ts` does), so edits to real
 * files stop invalidating the compiled module and local plugin fix-ups never
 * reload. Relative imports must therefore use exact `.ts` file specifiers.
 */
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sources(full)))
    else out.push(full)
  }
  return out
}

describe("relative imports use exact .ts specifiers", () => {
  test("every intra-package relative import points at a real file", async () => {
    const files = [...(await sources(join(ROOT, "src")))]
    const offenders: Array<{ file: string; spec: string }> = []
    for (const file of files) {
      const text = await readFile(file, "utf8")
      for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const spec = match[1]!
        if (spec.endsWith(".ts")) continue
        offenders.push({ file: relative(ROOT, file), spec })
      }
    }
    expect(offenders).toEqual([])
  })
})
