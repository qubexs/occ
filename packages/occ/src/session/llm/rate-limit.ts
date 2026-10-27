import { LLMKeyPool } from "./key-pool"

export type Bucket = {
  limit?: number
  remaining?: number
  /** Absolute epoch ms derived from the provider's reset header. */
  resetAt?: number
  retryAfterMs?: number
  status?: number
  updatedAt: number
}

export type Snapshot = Record<string, Bucket>

// Snapshots are keyed by *scope*, not by provider. Quota belongs to the
// credential that spent it: after a 429 the pool rotates to a different key
// with its own limits, and carrying the previous key's headroom forward would
// report numbers that belong to a credential no longer in use. A scope is an
// opaque id so raw keys never appear in state or logs.
const store = new Map<string, Snapshot>()

// Synthetic entries (`public` on the free tier, `oauth-managed` for providers
// whose credential the auth layer injects) are not rotated and therefore not
// scoped: they share the provider-wide snapshot.
export const scope = (providerID: string, key?: string | null): string =>
  key && !LLMKeyPool.isSyntheticKey(key) ? `${providerID}#${LLMKeyPool.fingerprint(key)}` : providerID

const belongsTo = (id: string, providerID: string): boolean => id === providerID || id.startsWith(`${providerID}#`)

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
const DURATION = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g

type Headers = Record<string, string | undefined>

const normalize = (headers: Headers | undefined): Headers => {
  if (!headers) return {}
  const out: Headers = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

const number = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

// OpenAI emits reset windows as compound durations ("6m0s", "1h2m3s", "100ms")
// while Anthropic emits RFC 3339 timestamps. Accept both, plus bare seconds.
export const parseReset = (value: string | undefined, now = Date.now()): number | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const at = Date.parse(trimmed)
    return Number.isNaN(at) ? undefined : Math.max(0, at - now)
  }
  let total = 0
  let matched = false
  for (const match of trimmed.matchAll(DURATION)) {
    total += Number(match[1]) * (UNITS[match[2]!] ?? 0)
    matched = true
  }
  if (matched) return total
  const seconds = Number(trimmed)
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

type Family = { readonly name: string; readonly limit: string; readonly remaining: string; readonly reset: string }

// Bucket names stay stable across providers so a single provider snapshot can
// mix response shapes without losing fields.
const FAMILIES: readonly Family[] = [
  {
    name: "requests",
    limit: "x-ratelimit-limit-requests",
    remaining: "x-ratelimit-remaining-requests",
    reset: "x-ratelimit-reset-requests",
  },
  {
    name: "tokens",
    limit: "x-ratelimit-limit-tokens",
    remaining: "x-ratelimit-remaining-tokens",
    reset: "x-ratelimit-reset-tokens",
  },
  {
    name: "requests",
    limit: "anthropic-ratelimit-requests-limit",
    remaining: "anthropic-ratelimit-requests-remaining",
    reset: "anthropic-ratelimit-requests-reset",
  },
  {
    name: "tokens",
    limit: "anthropic-ratelimit-tokens-limit",
    remaining: "anthropic-ratelimit-tokens-remaining",
    reset: "anthropic-ratelimit-tokens-reset",
  },
  {
    name: "input-tokens",
    limit: "anthropic-ratelimit-input-tokens-limit",
    remaining: "anthropic-ratelimit-input-tokens-remaining",
    reset: "anthropic-ratelimit-input-tokens-reset",
  },
  {
    name: "output-tokens",
    limit: "anthropic-ratelimit-output-tokens-limit",
    remaining: "anthropic-ratelimit-output-tokens-remaining",
    reset: "anthropic-ratelimit-output-tokens-reset",
  },
  { name: "requests", limit: "ratelimit-limit", remaining: "ratelimit-remaining", reset: "ratelimit-reset" },
]

const read = (headers: Headers, family: Family, now: number): Bucket | undefined => {
  const limit = number(headers[family.limit])
  const remaining = number(headers[family.remaining])
  const reset = parseReset(headers[family.reset], now)
  if (limit === undefined && remaining === undefined && reset === undefined) return undefined
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { resetAt: now + reset } : {}),
    updatedAt: now,
  }
}

export type RecordOptions = { status?: number; now?: number }

// Merge a response's quota headers into the scope's snapshot. Returns the
// merged snapshot, or undefined when the response carried no quota information.
export const record = (
  scope: string,
  headers: Headers | undefined,
  options: RecordOptions = {},
): Snapshot | undefined => {
  const now = options.now ?? Date.now()
  const normalized = normalize(headers)
  const parsed: Snapshot = {}
  for (const family of FAMILIES) {
    const bucket = read(normalized, family, now)
    if (bucket) parsed[family.name] = { ...parsed[family.name], ...bucket }
  }
  const retryAfterMs = LLMKeyPool.parseRetryAfter(normalized as Record<string, string>)
  if (retryAfterMs !== undefined) parsed.requests = { ...parsed.requests, retryAfterMs, updatedAt: now }
  if (Object.keys(parsed).length === 0) return undefined

  const previous = store.get(scope) ?? {}
  const next: Snapshot = { ...previous }
  for (const [name, bucket] of Object.entries(parsed)) {
    const merged: Bucket = { ...previous[name], ...bucket, updatedAt: now }
    if (options.status !== undefined) merged.status = options.status
    if (options.status !== 429 && bucket.retryAfterMs === undefined) delete merged.retryAfterMs
    next[name] = merged
  }
  store.set(scope, next)
  return next
}

export const snapshot = (scope: string): Snapshot | undefined => store.get(scope)

const duration = (ms: number): string => {
  if (ms <= 0) return "0s"
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remSeconds = seconds % 60
  if (minutes < 60) return remSeconds > 0 ? `${minutes}m${remSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return remMinutes > 0 ? `${hours}h${remMinutes}m` : `${hours}h`
}

export const format = (scope: string, now = Date.now()): string | undefined => {
  const current = store.get(scope)
  if (!current) return undefined
  const parts: string[] = []
  for (const [name, bucket] of Object.entries(current)) {
    const bits: string[] = []
    if (bucket.remaining !== undefined) {
      bits.push(bucket.limit !== undefined ? `${bucket.remaining}/${bucket.limit} left` : `${bucket.remaining} left`)
    } else if (bucket.limit !== undefined) {
      bits.push(`limit ${bucket.limit}`)
    }
    if (bucket.resetAt !== undefined) {
      bits.push(bucket.resetAt > now ? `resets in ${duration(bucket.resetAt - now)}` : "reset elapsed")
    }
    if (bucket.retryAfterMs !== undefined) {
      const wait = Math.max(0, bucket.updatedAt + bucket.retryAfterMs - now)
      bits.push(wait > 0 ? `retry in ${duration(wait)}` : "retry window elapsed")
    }
    if (bits.length > 0) parts.push(`${name} ${bits.join(", ")}`)
  }
  return parts.length > 0 ? parts.join("; ") : undefined
}

// True when any bucket is exhausted or under `ratio` of its limit.
export const low = (scope: string, ratio = 0.1): boolean => {
  const current = store.get(scope)
  if (!current) return false
  return Object.values(current).some(
    (bucket) =>
      bucket.remaining !== undefined &&
      (bucket.remaining <= 0 ||
        (bucket.limit !== undefined && bucket.limit > 0 && bucket.remaining / bucket.limit <= ratio)),
  )
}

// A key whose last response reported a spent window will reject the next request
// until that window resets. Knowing this lets the pool skip it instead of paying
// for a guaranteed 429.
export const exhausted = (scope: string, now = Date.now()): boolean => {
  const current = store.get(scope)
  if (!current) return false
  return Object.values(current).some((bucket) => {
    if (bucket.retryAfterMs !== undefined && bucket.updatedAt + bucket.retryAfterMs > now) return true
    if (bucket.remaining !== 0) return false
    // Without a reset header only a 429 is authoritative: a plain 200 reporting
    // "0 left" has no known window and may already be stale.
    if (bucket.resetAt === undefined) return bucket.status === 429
    return bucket.resetAt > now
  })
}

// Without an argument every scope is dropped. With a provider id, that
// provider's own snapshot and all of its per-key scopes go together.
export const clear = (providerID?: string): void => {
  if (providerID === undefined) {
    store.clear()
    return
  }
  // Deleting during Map iteration is well-defined: removed entries are skipped.
  for (const id of store.keys()) {
    if (belongsTo(id, providerID)) store.delete(id)
  }
}

// Drop scopes whose key left the rotation (a hot reload removed a credential)
// so the store does not accumulate snapshots for dead keys.
export const retain = (providerID: string, keys: readonly string[]): void => {
  const keep = new Set(keys.map((key) => scope(providerID, key)))
  for (const id of store.keys()) {
    if (belongsTo(id, providerID) && !keep.has(id)) store.delete(id)
  }
}

export * as LLMRateLimit from "./rate-limit"
