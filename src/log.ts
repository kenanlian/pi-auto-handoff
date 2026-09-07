export type LogLevel = "debug" | "info" | "warn" | "error"

export type Logger = {
  log: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void
}

export function createLogger(input: {
  enabled: boolean
  write: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void
}): Logger {
  return {
    log(level, message, extra) {
      if (!input.enabled && level !== "error") return
      input.write(level, message, extra)
    },
  }
}
