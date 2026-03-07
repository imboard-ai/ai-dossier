type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  context: string;
  message: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry): void {
  try {
    const output = JSON.stringify(entry);
    if (entry.level === 'error') {
      console.error(output);
    } else if (entry.level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  } catch {
    console.error(
      JSON.stringify({
        level: 'error',
        context: entry.context,
        message: `Log serialization failed for: ${entry.message}`,
      })
    );
  }
}

/**
 * Create a structured JSON logger scoped to a module context.
 *
 * Each log entry is emitted as a single-line JSON string to stdout (debug, info)
 * or stderr (warn, error), compatible with Vercel's log ingestion.
 */
function createLogger(context: string) {
  return {
    debug(message: string, extra?: Record<string, unknown>) {
      emit({ level: 'debug', context, message, ...extra });
    },
    info(message: string, extra?: Record<string, unknown>) {
      emit({ level: 'info', context, message, ...extra });
    },
    warn(message: string, extra?: Record<string, unknown>) {
      emit({ level: 'warn', context, message, ...extra });
    },
    error(message: string, extra?: Record<string, unknown>) {
      emit({ level: 'error', context, message, ...extra });
    },
  };
}

export default createLogger;
