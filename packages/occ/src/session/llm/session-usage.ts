// Per-session LLM call accounting.
//
// Tokens and cost are already persisted on the session row (`session.ts` folds
// them out of each step's usage), so this module deliberately tracks only the
// dimension nothing else records: how many model calls a session has made.
// That is what turns a bare 429 into "you have made N calls in this chat".

export type Counter = {
  requests: number
  firstAt: number
  lastAt: number
}

const store = new Map<string, Counter>()

// A long-lived server hosts many sessions; keep the map bounded by evicting the
// least recently used one instead of growing forever.
export const MAX_SESSIONS = 1_000

const evict = (): void => {
  if (store.size < MAX_SESSIONS) return
  let oldestID: string | undefined
  let oldest = Number.POSITIVE_INFINITY
  for (const [id, counter] of store) {
    if (counter.lastAt < oldest) {
      oldest = counter.lastAt
      oldestID = id
    }
  }
  if (oldestID !== undefined) store.delete(oldestID)
}

// Count one model call and return the running total for the session.
export const begin = (sessionID: string, now = Date.now()): number => {
  const current = store.get(sessionID)
  if (current) {
    current.requests++
    current.lastAt = now
    return current.requests
  }
  evict()
  store.set(sessionID, { requests: 1, firstAt: now, lastAt: now })
  return 1
}

export const get = (sessionID: string): Counter | undefined => store.get(sessionID)

export const size = (): number => store.size

export const clear = (sessionID?: string): void => {
  if (sessionID === undefined) store.clear()
  else store.delete(sessionID)
}

export * as LLMSessionUsage from "./session-usage"
