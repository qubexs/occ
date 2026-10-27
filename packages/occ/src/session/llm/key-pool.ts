export type KeyEntry = {
  readonly key: string
  cooldownUntil: number
  consecutiveFailures: number
  totalUses: number
  invalid: boolean
}

export type KeyRing = {
  readonly keys: KeyEntry[]
  cursor: number
}

const ringStore = new Map<string, KeyRing>()

export const normalize = (value: unknown): string[] | undefined => {
  if (typeof value === "string" && value.length > 0) return [value]
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      if (typeof item === "string" && item.length > 0) out.push(item)
    }
    return out.length > 0 ? out : undefined
  }
  return undefined
}

export const register = (providerID: string, keys: readonly string[]): KeyRing | undefined => {
  const unique = [...new Set(keys)]
  if (unique.length === 0) return undefined
  const entries: KeyEntry[] = unique.map((key) => newEntry(key))
  const ring: KeyRing = { keys: entries, cursor: 0 }
  ringStore.set(providerID, ring)
  return ring
}

// Stable, opaque id for a credential so logs and quota scopes can name a key
// without putting the secret in them. FNV-1a, 8 hex characters.
export const fingerprint = (key: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

const newEntry = (key: string): KeyEntry => ({
  key,
  cooldownUntil: 0,
  consecutiveFailures: 0,
  totalUses: 0,
  invalid: false,
})

export type SyncResult = {
  readonly changed: boolean
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly keys: readonly string[]
}

// Reconcile a ring against a freshly read credential source without discarding
// the bookkeeping of keys that survived. Used by the reload watcher so rotating
// one key does not reset cooldowns on the others.
export const sync = (providerID: string, keys: readonly string[]): SyncResult => {
  const unique = [...new Set(keys)]
  const ring = ringStore.get(providerID)

  if (unique.length === 0) {
    ringStore.delete(providerID)
    return { changed: ring !== undefined, added: [], removed: ring?.keys.map((e) => e.key) ?? [], keys: [] }
  }

  if (!ring) {
    register(providerID, unique)
    return { changed: true, added: unique, removed: [], keys: unique }
  }

  const existing = new Map(ring.keys.map((entry) => [entry.key, entry]))
  const next = unique.map((key) => existing.get(key) ?? newEntry(key))
  const added = unique.filter((key) => !existing.has(key))
  const removed = ring.keys.filter((entry) => !unique.includes(entry.key)).map((entry) => entry.key)
  const reordered = ring.keys.length === next.length && ring.keys.some((entry, index) => entry.key !== next[index]!.key)

  if (added.length === 0 && removed.length === 0 && !reordered) {
    return { changed: false, added, removed, keys: unique }
  }

  ringStore.set(providerID, { keys: next, cursor: next.length === 0 ? 0 : ring.cursor % next.length })
  return { changed: true, added, removed, keys: unique }
}

export const get = (providerID: string): KeyRing | undefined => ringStore.get(providerID)

export const has = (providerID: string): boolean => ringStore.has(providerID)

export const size = (providerID: string): number => ringStore.get(providerID)?.keys.length ?? 0

// Rings are seeded with placeholder entries when a provider has no configured
// key: `public` for the anonymous free tier, and `oauth-managed` for providers
// whose credential the auth layer injects itself. They occupy a ring slot so
// `pick` keeps returning them and request construction is unchanged, but they
// are not keys: they must never be counted as one, cooled down, or reported.
const SYNTHETIC_KEYS = new Set(["public", "oauth-managed"])

export const isPublicKey = (key: string): boolean => key === "public"

export const isSyntheticKey = (key: string): boolean => SYNTHETIC_KEYS.has(key)

const real = (ring: KeyRing) => ring.keys.filter((entry) => !isSyntheticKey(entry.key))

export const hasReal = (providerID: string): boolean => {
  const ring = ringStore.get(providerID)
  return ring !== undefined && real(ring).length > 0
}

const DEFAULT_COOLDOWN_MS = 30_000
const MAX_COOLDOWN_MS = 120_000

// `markInvalid` parks a rejected key for 24 hours, which only makes sense if the
// key becomes eligible again afterwards: a transient 401/402 must not remove a
// credential for the whole lifetime of the process. Reviving is done lazily so a
// single timestamp drives both the cooldown and the invalid flag.
const revive = (entry: KeyEntry, now: number): void => {
  if (!entry.invalid || entry.cooldownUntil > now) return
  entry.invalid = false
  entry.cooldownUntil = 0
}

const usable = (entry: KeyEntry, now: number): boolean => {
  revive(entry, now)
  return !entry.invalid && entry.cooldownUntil <= now
}

// `skip` lets the caller veto keys it already knows will be rejected — quota
// headers from the previous response are the usual reason. If every key is
// vetoed the loop runs again without the veto, so a stale snapshot can never
// strand a request.
export const pick = (providerID: string, now = Date.now(), skip?: (key: string) => boolean): string | undefined => {
  const ring = ringStore.get(providerID)
  if (!ring || ring.keys.length === 0) return undefined

  const choose = (honorSkip: boolean): KeyEntry | undefined => {
    for (let i = 0; i < ring.keys.length; i++) {
      const idx = (ring.cursor + i) % ring.keys.length
      const entry = ring.keys[idx]!
      if (!usable(entry, now)) continue
      if (honorSkip && skip?.(entry.key)) continue
      ring.cursor = (idx + 1) % ring.keys.length
      entry.totalUses++
      return entry
    }
    return undefined
  }

  const ready = (skip ? choose(true) : undefined) ?? choose(false)
  if (ready) return ready.key

  const live = ring.keys.filter((e) => !e.invalid)
  if (live.length === 0) return undefined
  const soonest = live.reduce((best, e) => (e.cooldownUntil < best.cooldownUntil ? e : best))
  if (soonest.cooldownUntil - now > MAX_COOLDOWN_MS) return undefined
  soonest.totalUses++
  return soonest.key
}

// True when a ready key other than `exclude` exists. A failed request can then
// be retried immediately on that key instead of waiting for `exclude` to cool
// down — the difference between a one second failover and a full retry-after
// stall when ten keys are configured.
export const hasAlternative = (providerID: string, exclude: string, now = Date.now()): boolean => {
  const ring = ringStore.get(providerID)
  if (!ring) return false
  return ring.keys.some((e) => !isSyntheticKey(e.key) && e.key !== exclude && usable(e, now))
}

// Statuses that describe the credential rather than the request, so another key
// in the pool may succeed where this one failed.
const CREDENTIAL_STATUSES = new Set([401, 402, 403, 429])

export const canFailover = (
  providerID: string,
  key: string | null,
  status: number | undefined,
  now = Date.now(),
): boolean =>
  key !== null && status !== undefined && CREDENTIAL_STATUSES.has(status) && hasAlternative(providerID, key, now)

export const markRateLimited = (
  providerID: string,
  key: string,
  retryAfterMs: number | undefined,
  now = Date.now(),
): void => {
  const ring = ringStore.get(providerID)
  if (!ring) return
  if (isSyntheticKey(key)) return
  const entry = ring.keys.find((e) => e.key === key)
  if (!entry) return
  const base = retryAfterMs ?? DEFAULT_COOLDOWN_MS
  const ramp = Math.min(MAX_COOLDOWN_MS, base * 2 ** entry.consecutiveFailures)
  entry.cooldownUntil = now + ramp
  entry.consecutiveFailures++
}

export const markSuccess = (providerID: string, key: string): void => {
  const ring = ringStore.get(providerID)
  if (!ring) return
  if (isSyntheticKey(key)) return
  const entry = ring.keys.find((e) => e.key === key)
  if (!entry) return
  entry.consecutiveFailures = 0
  entry.cooldownUntil = 0
  entry.invalid = false
}

const PERMANENT_COOLDOWN_MS = 24 * 60 * 60 * 1000

export const markInvalid = (providerID: string, key: string, now = Date.now()): void => {
  const ring = ringStore.get(providerID)
  if (!ring) return
  if (isSyntheticKey(key)) return
  const entry = ring.keys.find((e) => e.key === key)
  if (!entry) return
  entry.invalid = true
  entry.cooldownUntil = now + PERMANENT_COOLDOWN_MS
  entry.consecutiveFailures++
}

export const clear = (providerID?: string): void => {
  if (providerID) ringStore.delete(providerID)
  else ringStore.clear()
}

export const parseRetryAfter = (headers: Record<string, string> | undefined): number | undefined => {
  if (!headers) return undefined
  const msRaw = headers["retry-after-ms"] ?? headers["Retry-After-Ms"]
  if (msRaw) {
    const ms = Number(msRaw)
    if (Number.isFinite(ms)) return Math.max(0, ms)
  }
  const secRaw = headers["retry-after"] ?? headers["Retry-After"]
  if (secRaw) {
    const sec = Number(secRaw)
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000)
    const date = Date.parse(secRaw)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

export const summary = (providerID: string, now = Date.now()): string => {
  const ring = ringStore.get(providerID)
  if (!ring) return "no key pool"
  const keys = real(ring)
  if (keys.length === 0) {
    if (ring.keys.some((e) => isPublicKey(e.key))) return "free tier (public)"
    if (ring.keys.length > 0) return "managed auth (no key)"
    return "no key pool"
  }
  // A ten key pool would make a per-key dump unreadable, so report the aggregate
  // and only name the keys that are not usable right now.
  const ready = keys.filter((e) => usable(e, now)).length
  const parts = [`${keys.length} key${keys.length === 1 ? "" : "s"}: ${ready} ready`]
  keys.forEach((e, i) => {
    if (e.invalid) parts.push(`[${i}] invalid`)
    else if (e.cooldownUntil > now) {
      const secs = Math.ceil((e.cooldownUntil - now) / 1000)
      const fails = e.consecutiveFailures > 1 ? ` (fails=${e.consecutiveFailures})` : ""
      parts.push(`[${i}] cooldown ${secs}s${fails}`)
    }
  })
  return parts.join(", ")
}

export const formatStartup = (): string | undefined => {
  const rings = [...ringStore.entries()].flatMap(([providerID, ring]) => {
    const keys = real(ring)
    return keys.length === 0 ? [] : [[providerID, keys] as const]
  })
  if (rings.length === 0) return undefined
  return rings
    .map(([providerID, keys]) => {
      const ready = keys.filter((e) => !e.invalid && e.cooldownUntil <= Date.now()).length
      const invalid = keys.filter((e) => e.invalid).length
      return `${providerID}: ${keys.length} key${keys.length === 1 ? "" : "s"} (${ready} ready${invalid ? `, ${invalid} invalid` : ""})`
    })
    .join("; ")
}

export * as LLMKeyPool from "./key-pool"
