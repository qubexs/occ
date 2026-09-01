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
  if (keys.length === 0) return undefined
  const entries: KeyEntry[] = keys.map((key) => ({
    key,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    totalUses: 0,
    invalid: false,
  }))
  const ring: KeyRing = { keys: entries, cursor: 0 }
  ringStore.set(providerID, ring)
  return ring
}

export const get = (providerID: string): KeyRing | undefined => ringStore.get(providerID)

export const has = (providerID: string): boolean => ringStore.has(providerID)

export const size = (providerID: string): number => ringStore.get(providerID)?.keys.length ?? 0

const DEFAULT_COOLDOWN_MS = 30_000
const MAX_COOLDOWN_MS = 120_000

export const pick = (providerID: string, now = Date.now()): string | undefined => {
  const ring = ringStore.get(providerID)
  if (!ring || ring.keys.length === 0) return undefined
  const available = ring.keys.filter((e) => !e.invalid && e.cooldownUntil <= now)
  if (available.length === 0) {
    const live = ring.keys.filter((e) => !e.invalid)
    if (live.length === 0) return undefined
    const soonest = live.reduce((best, e) => (e.cooldownUntil < best.cooldownUntil ? e : best))
    if (soonest.cooldownUntil - now > MAX_COOLDOWN_MS) return undefined
    soonest.totalUses++
    return soonest.key
  }
  const start = ring.cursor
  for (let i = 0; i < ring.keys.length; i++) {
    const idx = (start + i) % ring.keys.length
    const entry = ring.keys[idx]
    if (!entry.invalid && entry.cooldownUntil <= now) {
      ring.cursor = (idx + 1) % ring.keys.length
      entry.totalUses++
      return entry.key
    }
  }
  return undefined
}

export const markRateLimited = (
  providerID: string,
  key: string,
  retryAfterMs: number | undefined,
  now = Date.now(),
): void => {
  const ring = ringStore.get(providerID)
  if (!ring) return
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

export const summary = (providerID: string): string => {
  const ring = ringStore.get(providerID)
  if (!ring) return "no key pool"
  return ring.keys
    .map((e, i) => {
      let state: string
      if (e.invalid) state = "invalid"
      else if (e.cooldownUntil > Date.now()) state = `cooldown ${Math.ceil((e.cooldownUntil - Date.now()) / 1000)}s`
      else state = "ready"
      return `[${i}] uses=${e.totalUses} fails=${e.consecutiveFailures} ${state}`
    })
    .join(" | ")
}

export const formatStartup = (): string | undefined => {
  const rings = [...ringStore.entries()]
  if (rings.length === 0) return undefined
  return rings
    .map(([providerID, ring]) => {
      const total = ring.keys.length
      const ready = ring.keys.filter((e) => !e.invalid && e.cooldownUntil <= Date.now()).length
      const invalid = ring.keys.filter((e) => e.invalid).length
      return `${providerID}: ${total} key${total === 1 ? "" : "s"} (${ready} ready${invalid ? `, ${invalid} invalid` : ""})`
    })
    .join("; ")
}

export const isPublicKey = (key: string): boolean => key === "public"

export * as LLMKeyPool from "./key-pool"
