import { beforeEach, describe, expect, test } from "bun:test"
import { LLMKeyPool } from "../../src/session/llm/key-pool"

const provider = "opencode"

beforeEach(() => {
  LLMKeyPool.clear()
})

describe("LLMKeyPool synthetic entries", () => {
  test("a public-only ring keeps serving the sentinel but reports no real key", () => {
    LLMKeyPool.register(provider, ["public"])

    expect(LLMKeyPool.pick(provider)).toBe("public")
    expect(LLMKeyPool.has(provider)).toBe(true)
    expect(LLMKeyPool.size(provider)).toBe(1)
    expect(LLMKeyPool.hasReal(provider)).toBe(false)
    expect(LLMKeyPool.summary(provider)).toBe("free tier (public)")
    expect(LLMKeyPool.formatStartup()).toBeUndefined()
  })

  test("an oauth-managed ring is not reported as a key", () => {
    LLMKeyPool.register(provider, ["oauth-managed"])

    expect(LLMKeyPool.pick(provider)).toBe("oauth-managed")
    expect(LLMKeyPool.hasReal(provider)).toBe(false)
    expect(LLMKeyPool.summary(provider)).toBe("managed auth (no key)")
    expect(LLMKeyPool.formatStartup()).toBeUndefined()
  })

  test("markInvalid on the public sentinel does not poison the ring", () => {
    LLMKeyPool.register(provider, ["public"])
    LLMKeyPool.markInvalid(provider, "public")

    expect(LLMKeyPool.pick(provider)).toBe("public")
    expect(LLMKeyPool.summary(provider)).toBe("free tier (public)")
  })

  test("markRateLimited on the public sentinel sets no cooldown", () => {
    const now = 1_000_000
    LLMKeyPool.register(provider, ["public"])
    LLMKeyPool.markRateLimited(provider, "public", 60_000, now)

    expect(LLMKeyPool.pick(provider, now)).toBe("public")
    expect(LLMKeyPool.pick(provider, now + 1)).toBe("public")
  })

  test("markSuccess on a synthetic entry is a no-op", () => {
    LLMKeyPool.register(provider, ["public"])
    LLMKeyPool.markSuccess(provider, "public")

    expect(LLMKeyPool.get(provider)?.keys[0]?.invalid).toBe(false)
    expect(LLMKeyPool.get(provider)?.keys[0]?.cooldownUntil).toBe(0)
  })
})

describe("LLMKeyPool real keys", () => {
  test("rotates across registered keys", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])

    expect(LLMKeyPool.hasReal(provider)).toBe(true)
    expect(LLMKeyPool.pick(provider)).toBe("key-a")
    expect(LLMKeyPool.pick(provider)).toBe("key-b")
    expect(LLMKeyPool.pick(provider)).toBe("key-a")
  })

  test("skips a rate-limited key until its cooldown expires", () => {
    const now = Date.now()
    LLMKeyPool.register(provider, ["key-a", "key-b"])
    LLMKeyPool.markRateLimited(provider, "key-a", 30_000, now)

    expect(LLMKeyPool.pick(provider, now)).toBe("key-b")
    expect(LLMKeyPool.pick(provider, now + 29_999)).toBe("key-b")
    expect(LLMKeyPool.summary(provider)).toContain("cooldown")
    expect(LLMKeyPool.pick(provider, now + 30_000)).toBe("key-a")
  })

  test("skips an invalid key permanently and reports it", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])
    LLMKeyPool.markInvalid(provider, "key-a")

    expect(LLMKeyPool.pick(provider)).toBe("key-b")
    expect(LLMKeyPool.pick(provider)).toBe("key-b")
    expect(LLMKeyPool.summary(provider)).toContain("invalid")
  })

  test("markSuccess clears cooldown and failure count", () => {
    const now = Date.now()
    LLMKeyPool.register(provider, ["key-a"])
    LLMKeyPool.markRateLimited(provider, "key-a", 30_000, now)
    LLMKeyPool.markSuccess(provider, "key-a")

    const entry = LLMKeyPool.get(provider)?.keys[0]
    expect(entry?.cooldownUntil).toBe(0)
    expect(entry?.consecutiveFailures).toBe(0)
    expect(LLMKeyPool.pick(provider, now)).toBe("key-a")
  })

  test("formatStartup counts only real keys", () => {
    LLMKeyPool.register("alpha", ["key-a", "key-b"])
    LLMKeyPool.register("beta", ["public"])

    expect(LLMKeyPool.formatStartup()).toBe("alpha: 2 keys (2 ready)")
  })
})

describe("LLMKeyPool sync", () => {
  test("seeds a ring that does not exist yet", () => {
    const result = LLMKeyPool.sync(provider, ["key-a", "key-b"])

    expect(result).toEqual({ changed: true, added: ["key-a", "key-b"], removed: [], keys: ["key-a", "key-b"] })
    expect(LLMKeyPool.size(provider)).toBe(2)
  })

  test("reports no change for an identical ring", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])
    const result = LLMKeyPool.sync(provider, ["key-a", "key-b"])

    expect(result.changed).toBe(false)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  test("adds a key without resetting the surviving keys", () => {
    const now = Date.now()
    LLMKeyPool.register(provider, ["key-a"])
    LLMKeyPool.markRateLimited(provider, "key-a", 30_000, now)

    const result = LLMKeyPool.sync(provider, ["key-a", "key-b"])

    expect(result).toEqual({ changed: true, added: ["key-b"], removed: [], keys: ["key-a", "key-b"] })
    expect(LLMKeyPool.get(provider)?.keys[0]?.cooldownUntil).toBe(now + 30_000)
  })

  test("removes a rotated-out key and keeps the rest usable", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])
    LLMKeyPool.markInvalid(provider, "key-b")

    const result = LLMKeyPool.sync(provider, ["key-a"])

    expect(result).toEqual({ changed: true, added: [], removed: ["key-b"], keys: ["key-a"] })
    expect(LLMKeyPool.pick(provider)).toBe("key-a")
  })

  test("removing every credential drops the ring", () => {
    LLMKeyPool.register(provider, ["key-a"])
    const result = LLMKeyPool.sync(provider, [])

    expect(result).toEqual({ changed: true, added: [], removed: ["key-a"], keys: [] })
    expect(LLMKeyPool.has(provider)).toBe(false)
  })

  test("syncing an empty list onto an absent ring reports no change", () => {
    const result = LLMKeyPool.sync(provider, [])

    expect(result).toEqual({ changed: false, added: [], removed: [], keys: [] })
  })

  test("reorders entries while preserving their bookkeeping", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])
    LLMKeyPool.markInvalid(provider, "key-a")

    const result = LLMKeyPool.sync(provider, ["key-b", "key-a"])

    expect(result.changed).toBe(true)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(LLMKeyPool.get(provider)?.keys.map((entry) => entry.key)).toEqual(["key-b", "key-a"])
    expect(LLMKeyPool.get(provider)?.keys[1]?.invalid).toBe(true)
  })

  test("deduplicates repeated keys", () => {
    const result = LLMKeyPool.sync(provider, ["key-a", "key-a", "key-b"])

    expect(result.keys).toEqual(["key-a", "key-b"])
    expect(LLMKeyPool.size(provider)).toBe(2)
  })

  test("keeps the cursor inside the new ring size", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b", "key-c"])
    LLMKeyPool.pick(provider)
    LLMKeyPool.pick(provider)
    LLMKeyPool.pick(provider)

    LLMKeyPool.sync(provider, ["key-c"])

    expect(LLMKeyPool.pick(provider)).toBe("key-c")
  })
})

describe("LLMKeyPool ten keys", () => {
  const keys = Array.from({ length: 10 }, (_, index) => `key-${index}`)

  test("uses every key once per lap", () => {
    LLMKeyPool.register(provider, keys)

    expect(Array.from({ length: 10 }, () => LLMKeyPool.pick(provider))).toEqual(keys)
    expect(LLMKeyPool.pick(provider)).toBe(keys[0])
  })

  test("drops a cooling key out of the lap and puts it back afterwards", () => {
    const now = 1_000_000
    LLMKeyPool.register(provider, keys)
    LLMKeyPool.markRateLimited(provider, "key-3", 60_000, now)

    expect(Array.from({ length: 10 }, () => LLMKeyPool.pick(provider, now + 1))).toEqual([
      "key-0",
      "key-1",
      "key-2",
      "key-4",
      "key-5",
      "key-6",
      "key-7",
      "key-8",
      "key-9",
      "key-0",
    ])

    const lap = Array.from({ length: 10 }, () => LLMKeyPool.pick(provider, now + 60_000))
    expect(lap).toContain("key-3")
  })

  test("register deduplicates repeated keys", () => {
    LLMKeyPool.register(provider, ["key-a", "key-a", "key-b"])

    expect(LLMKeyPool.size(provider)).toBe(2)
  })

  test("summary stays short for a large pool", () => {
    const now = Date.now()
    LLMKeyPool.register(provider, keys)
    LLMKeyPool.markRateLimited(provider, "key-3", 60_000, now)
    LLMKeyPool.markInvalid(provider, "key-7")

    const text = LLMKeyPool.summary(provider)

    expect(text.startsWith("10 keys: 8 ready")).toBe(true)
    expect(text).toContain("[3] cooldown")
    expect(text).toContain("[7] invalid")
    expect(text.split(",")).toHaveLength(3)
  })
})

describe("LLMKeyPool failover", () => {
  test("a credential failure with another ready key is retryable", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])

    expect(LLMKeyPool.canFailover(provider, "key-a", 429)).toBe(true)
    expect(LLMKeyPool.canFailover(provider, "key-a", 401)).toBe(true)
    expect(LLMKeyPool.canFailover(provider, "key-a", 402)).toBe(true)
  })

  test("is false when no other key is ready", () => {
    const now = Date.now()
    LLMKeyPool.register(provider, ["key-a", "key-b"])
    LLMKeyPool.markRateLimited(provider, "key-b", 60_000, now)

    expect(LLMKeyPool.canFailover(provider, "key-a", 429, now)).toBe(false)
    expect(LLMKeyPool.hasAlternative(provider, "key-b", now)).toBe(true)
  })

  test("ignores failures that are not about the credential", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])

    expect(LLMKeyPool.canFailover(provider, "key-a", 500)).toBe(false)
    expect(LLMKeyPool.canFailover(provider, "key-a", undefined)).toBe(false)
    expect(LLMKeyPool.canFailover(provider, null, 429)).toBe(false)
    expect(LLMKeyPool.canFailover("missing", "key-a", 429)).toBe(false)
  })

  test("a synthetic entry never counts as an alternative", () => {
    LLMKeyPool.register(provider, ["key-a", "public"])

    expect(LLMKeyPool.hasAlternative(provider, "key-a")).toBe(false)
  })
})

describe("LLMKeyPool quota-aware picking", () => {
  test("skips keys the caller knows are out of quota", () => {
    const now = 1_000_000
    LLMKeyPool.register(provider, ["key-a", "key-b", "key-c"])
    const skip = (key: string) => key === "key-a"

    expect(LLMKeyPool.pick(provider, now, skip)).toBe("key-b")
    expect(LLMKeyPool.pick(provider, now, skip)).toBe("key-c")
    expect(LLMKeyPool.pick(provider, now, skip)).toBe("key-b")
  })

  test("falls back to rotation when every key is vetoed", () => {
    LLMKeyPool.register(provider, ["key-a", "key-b"])

    expect(LLMKeyPool.pick(provider, 1_000_000, () => true)).toBe("key-a")
  })
})

describe("LLMKeyPool invalid recovery", () => {
  const day = 24 * 60 * 60 * 1000

  test("a rejected key is parked and later allowed back", () => {
    const now = 1_000_000
    LLMKeyPool.register(provider, ["key-a"])
    LLMKeyPool.markInvalid(provider, "key-a", now)

    expect(LLMKeyPool.pick(provider, now)).toBeUndefined()
    expect(LLMKeyPool.summary(provider, now)).toContain("invalid")

    expect(LLMKeyPool.pick(provider, now + day)).toBe("key-a")
    expect(LLMKeyPool.summary(provider, now + day)).toBe("1 key: 1 ready")
  })
})

describe("LLMKeyPool normalize", () => {
  test("accepts a single key or an array of keys", () => {
    expect(LLMKeyPool.normalize("key-a")).toEqual(["key-a"])
    expect(LLMKeyPool.normalize(["key-a", "key-b"])).toEqual(["key-a", "key-b"])
    expect(LLMKeyPool.normalize([])).toBeUndefined()
    expect(LLMKeyPool.normalize("")).toBeUndefined()
    expect(LLMKeyPool.normalize(undefined)).toBeUndefined()
  })
})

describe("LLMKeyPool parseRetryAfter", () => {
  test("reads millisecond, second and HTTP-date headers", () => {
    expect(LLMKeyPool.parseRetryAfter({ "retry-after-ms": "1500" })).toBe(1500)
    expect(LLMKeyPool.parseRetryAfter({ "retry-after": "3" })).toBe(3000)
    expect(LLMKeyPool.parseRetryAfter(undefined)).toBeUndefined()
  })
})
