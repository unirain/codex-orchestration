import { setTimeout as delay } from 'node:timers/promises'

export const retryable = new Set(['serverOverloaded', 'internalServerError', 'httpConnectionFailed',
  'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'flexUnavailable'])
export const intervals = [15_000, 30_000, 60_000]

/** Invoke only after a known terminal failure. The host confirms eligibility and
 * reconciles inputs/side effects before each attempt. Unknown outcomes never
 * enter this loop. Main Eval deadlines are controlled by the domain engine. */
export async function retryWorker<T>(options: {
  attempt: (attemptNumber: number) => Promise<{value: T, errorCode?: string}>
  canRetry: (value: T) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  onRetry?: (attempt: number, waitMs: number, errorCode: string) => void
}): Promise<{value: T, attempts: number}> {
  for (let i = 0; ; i++) {
    const {value, errorCode} = await options.attempt(i + 1)
    if (!errorCode || !retryable.has(errorCode) || i === intervals.length || !await options.canRetry(value))
      return {value, attempts: i + 1}
    options.onRetry?.(i + 2, intervals[i], errorCode)
    await (options.sleep ?? delay)(intervals[i])
    if (!await options.canRetry(value)) return {value, attempts: i + 1}
  }
}
