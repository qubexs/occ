import { beforeEach, describe, expect, test } from "bun:test"
import { LLMRateLimit } from "../../src/session/llm/rate-limit"

const provider = "opencode"
const now = 1_700_000_000_000

beforeEach(() => {
  LLMRateLimit.clear()
})

describe("LLMRateLimit.parseReset", () => {
  test("parses OpenAI compound durations", () => {
    expect(LLMRateLimit.parseReset("6m0s", now)).toBe(360_000)
    expect(LLMRateLimit.parseReset("1h2m3s", now)).toBe(3_723_000)
    expect(LLMRateLimit.parseReset("100ms", now)).toBe(100)
    expect(LLMRateLimit.parseReset("45", now)).toBe(45_000)
  })

  test("parses Anthropic RFC 3339 timestamps relative to now", () => {
    expect(LLMRateLimit.parseReset(new Date(now + 60_000).toISOString(), now)).toBe(60_000)
    expect(LLMRateLimit.parseReset(new Date(now - 60_000).toISOString(), now)).toBe(0)
  })

  test("ignores empty and unparseable values", () => {
    expect(LLMRateLimit.parseReset(undefined, now)).toBeUndefined()
    expect(LLMRateLimit.parseReset("", now)).toBeUndefined()
    expect(LLMRateLimit.parseReset("soon", now)).toBeUndefined()
  })
})

describe("LLMRateLimit.record", () => {
  test("records OpenAI request and token buckets", () => {
    const snapshot = LLMRateLimit.record(
      provider,
      {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "7",
        "x-ratelimit-reset-requests": "6m0s",
        "x-ratelimit-limit-tokens": "30000",
        "x-ratelimit-remaining-tokens": "12000",
        "x-ratelimit-reset-tokens": "1m",
      },
      { now },
    )

    expect(snapshot?.requests).toMatchObject({ limit: 100, remaining: 7, resetAt: now + 360_000 })
    expect(snapshot?.tokens).toMatchObject({ limit: 30_000, remaining: 12_000, resetAt: now + 60_000 })
  })

  test("records Anthropic buckets with RFC 3339 resets", () => {
    const snapshot = LLMRateLimit.record(
      provider,
      {
        "anthropic-ratelimit-input-tokens-limit": "200000",
        "anthropic-ratelimit-input-tokens-remaining": "500",
        "anthropic-ratelimit-input-tokens-reset": new Date(now + 30_000).toISOString(),
      },
      { now },
    )

    expect(snapshot?.["input-tokens"]).toMatchObject({ limit: 200_000, remaining: 500, resetAt: now + 30_000 })
  })

  test("merges successive responses instead of replacing buckets", () => {
    LLMRateLimit.record(
      provider,
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "7" },
      { now },
    )
    const snapshot = LLMRateLimit.record(provider, { "x-ratelimit-remaining-requests": "3" }, { now: now + 1 })

    expect(snapshot?.requests).toMatchObject({ limit: 100, remaining: 3 })
  })

  test("carries retry-after on a 429 and drops it after a success", () => {
    LLMRateLimit.record(provider, { "retry-after": "12", "x-ratelimit-remaining-requests": "0" }, { status: 429, now })
    expect(LLMRateLimit.snapshot(provider)?.requests?.retryAfterMs).toBe(12_000)

    LLMRateLimit.record(provider, { "x-ratelimit-remaining-requests": "9" }, { status: 200, now: now + 1 })
    expect(LLMRateLimit.snapshot(provider)?.requests?.retryAfterMs).toBeUndefined()
    expect(LLMRateLimit.snapshot(provider)?.requests?.remaining).toBe(9)
  })

  test("returns undefined when a response carries no quota information", () => {
    expect(LLMRateLimit.record(provider, { "content-type": "application/json" }, { status: 200, now })).toBeUndefined()
    expect(LLMRateLimit.snapshot(provider)).toBeUndefined()
  })

  test("header lookup is case-insensitive", () => {
    const snapshot = LLMRateLimit.record(provider, { "X-RateLimit-Remaining-Requests": "42" }, { now })
    expect(snapshot?.requests?.remaining).toBe(42)
  })
})

describe("LLMRateLimit.format", () => {
  test("renders headroom and reset windows", () => {
    LLMRateLimit.record(
      provider,
      {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "7",
        "x-ratelimit-reset-requests": "6m0s",
      },
      { now },
    )

    expect(LLMRateLimit.format(provider, now)).toBe("requests 7/100 left, resets in 6m")
    expect(LLMRateLimit.format("other", now)).toBeUndefined()
  })

  test("renders retry-after", () => {
    LLMRateLimit.record(provider, { "retry-after": "12" }, { status: 429, now })
    expect(LLMRateLimit.format(provider, now)).toBe("requests retry in 12s")
  })

  test("counts down the retry window and reports it as elapsed", () => {
    LLMRateLimit.record(provider, { "retry-after": "12" }, { status: 429, now })
    expect(LLMRateLimit.format(provider, now + 5_000)).toBe("requests retry in 7s")
    expect(LLMRateLimit.format(provider, now + 12_000)).toBe("requests retry window elapsed")
  })
})

describe("LLMRateLimit.low", () => {
  test("flags exhausted and near-exhausted buckets", () => {
    LLMRateLimit.record(
      provider,
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "1" },
      { now },
    )
    expect(LLMRateLimit.low(provider)).toBe(true)

    LLMRateLimit.record(provider, { "x-ratelimit-remaining-requests": "50" }, { now })
    expect(LLMRateLimit.low(provider)).toBe(false)

    LLMRateLimit.record(provider, { "x-ratelimit-remaining-requests": "0" }, { now })
    expect(LLMRateLimit.low(provider)).toBe(true)
  })

  test("is false for unknown providers", () => {
    expect(LLMRateLimit.low("missing")).toBe(false)
  })
})

describe("LLMRateLimit.exhausted", () => {
  const keyA = LLMRateLimit.scope(provider, "sk-a")

  test("blocks only while the reported reset window is open", () => {
    LLMRateLimit.record(keyA, { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "60s" }, { now })

    expect(LLMRateLimit.exhausted(keyA, now)).toBe(true)
    expect(LLMRateLimit.exhausted(keyA, now + 59_000)).toBe(true)
    expect(LLMRateLimit.exhausted(keyA, now + 60_001)).toBe(false)
  })

  test("a 429 without a reset window still blocks", () => {
    LLMRateLimit.record(keyA, { "x-ratelimit-remaining-requests": "0" }, { status: 429, now })

    expect(LLMRateLimit.exhausted(keyA, now)).toBe(true)
  })

  test("a retry-after header blocks for its duration", () => {
    LLMRateLimit.record(keyA, { "retry-after": "30" }, { status: 429, now })

    expect(LLMRateLimit.exhausted(keyA, now)).toBe(true)
    expect(LLMRateLimit.exhausted(keyA, now + 30_001)).toBe(false)
  })

  test("is false for headroom and for unknown scopes", () => {
    LLMRateLimit.record(keyA, { "x-ratelimit-remaining-requests": "10" }, { now })

    expect(LLMRateLimit.exhausted(keyA, now)).toBe(false)
    expect(LLMRateLimit.exhausted("missing", now)).toBe(false)
  })
})

describe("LLMRateLimit.scope", () => {
  test("free-tier and managed credentials share the provider scope", () => {
    expect(LLMRateLimit.scope(provider)).toBe(provider)
    expect(LLMRateLimit.scope(provider, null)).toBe(provider)
    expect(LLMRateLimit.scope(provider, "public")).toBe(provider)
    expect(LLMRateLimit.scope(provider, "oauth-managed")).toBe(provider)
  })

  test("real keys get a stable, opaque scope", () => {
    const a = LLMRateLimit.scope(provider, "sk-aaaa")
    const b = LLMRateLimit.scope(provider, "sk-aaaa")
    const c = LLMRateLimit.scope(provider, "sk-bbbb")

    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith(`${provider}#`)).toBe(true)
    expect(a).not.toContain("sk-aaaa")
    expect(LLMRateLimit.scope("other", "sk-aaaa")).not.toBe(a)
  })
})

describe("LLMRateLimit scoping", () => {
  const keyA = LLMRateLimit.scope(provider, "sk-a")
  const keyB = LLMRateLimit.scope(provider, "sk-b")

  test("a rotation does not carry the previous key's headroom", () => {
    LLMRateLimit.record(
      keyA,
      { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0" },
      { status: 429, now },
    )

    expect(LLMRateLimit.low(keyA)).toBe(true)
    // The replacement key has not reported anything yet: no numbers beat old numbers.
    expect(LLMRateLimit.format(keyB, now)).toBeUndefined()
    expect(LLMRateLimit.low(keyB)).toBe(false)

    LLMRateLimit.record(keyB, { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "80" }, { now })

    expect(LLMRateLimit.format(keyB, now)).toBe("requests 80/100 left")
    expect(LLMRateLimit.format(keyA, now)).toBe("requests 0/100 left")
  })

  test("clear(provider) drops that provider's scopes and leaves others alone", () => {
    const other = LLMRateLimit.scope("other", "sk-a")
    LLMRateLimit.record(keyA, { "x-ratelimit-remaining-requests": "5" }, { now })
    LLMRateLimit.record(other, { "x-ratelimit-remaining-requests": "5" }, { now })

    LLMRateLimit.clear(provider)

    expect(LLMRateLimit.snapshot(keyA)).toBeUndefined()
    expect(LLMRateLimit.snapshot(provider)).toBeUndefined()
    expect(LLMRateLimit.snapshot(other)).toBeDefined()
  })

  test("retain forgets scopes for keys that left the rotation", () => {
    LLMRateLimit.record(keyA, { "x-ratelimit-remaining-requests": "5" }, { now })
    LLMRateLimit.record(keyB, { "x-ratelimit-remaining-requests": "5" }, { now })

    LLMRateLimit.retain(provider, ["sk-b"])

    expect(LLMRateLimit.snapshot(keyA)).toBeUndefined()
    expect(LLMRateLimit.snapshot(keyB)).toBeDefined()
  })
})
