import { homedir } from "node:os"
import path from "node:path"

/**
 * Lexical path helpers mirroring the evaluations of OpenCode's own read
 * pipeline (`FileAccess.resolvePath` and `FSUtil.contains`), so the wrapper's
 * internal/external detection matches the boundaries the native tool uses.
 */

/** Normalize Windows separators so `~` checks and path math behave. */
const windowsPath = (input: string): string => input.replaceAll("\\", "/")

/** Reproduces `FileAccess.resolvePath`: expand `~`, then resolve lexically. */
export function resolveWorkspacePath(input: string, directory: string, home = homedir()): string {
  const normalized = windowsPath(input)
  return path.resolve(
    directory,
    normalized === "~"
      ? home
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~/"))
        ? path.join(home, normalized.slice(2))
        : normalized,
  )
}

/** Lexical containment between two paths; case-agnostic on Windows. */
export function containsDirectory(parent: string, child: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  const from = fold(path.resolve(parent))
  const to = fold(path.resolve(child))
  const relative = path.relative(from, to)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * The native read fails on binary files with exactly this text
 * (`ReadTool.BinaryFileError`). The wrapper treats it as "permission was
 * already granted, media not yet attached" in the external-directory flow.
 */
export function isNativeBinaryFileFailure(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === "string" && message.startsWith("Cannot read binary file")
}
