import { appendFile, mkdir } from "node:fs/promises"
import path from "path"
import { defaultDataDir, type Options } from "./config.ts"

export type Logger = (msg: string) => void

/** Logging goes to a file, never to stdout/stderr: the host TUI owns the terminal. */
export function createLogger(log: Options["log"]): Logger {
  if (log === false) return () => {}
  const file = log === true ? path.join(defaultDataDir(), "plugin.log") : log
  let chain = mkdir(path.dirname(file), { recursive: true }).then(
    () => {},
    () => {},
  )
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`
    chain = chain.then(() => appendFile(file, line)).catch(() => {})
  }
}
