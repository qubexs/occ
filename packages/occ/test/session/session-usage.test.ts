import { beforeEach, describe, expect, test } from "bun:test"
import { LLMSessionUsage } from "../../src/session/llm/session-usage"

beforeEach(() => {
  LLMSessionUsage.clear()
})

describe("LLMSessionUsage", () => {
  test("counts model calls per session", () => {
    expect(LLMSessionUsage.begin("ses_a", 1_000)).toBe(1)
    expect(LLMSessionUsage.begin("ses_a", 2_000)).toBe(2)
    expect(LLMSessionUsage.begin("ses_b", 3_000)).toBe(1)

    expect(LLMSessionUsage.get("ses_a")).toEqual({ requests: 2, firstAt: 1_000, lastAt: 2_000 })
    expect(LLMSessionUsage.get("ses_b")).toEqual({ requests: 1, firstAt: 3_000, lastAt: 3_000 })
    expect(LLMSessionUsage.size()).toBe(2)
  })

  test("returns undefined for sessions that never made a call", () => {
    expect(LLMSessionUsage.get("ses_missing")).toBeUndefined()
  })

  test("clears one session or every session", () => {
    LLMSessionUsage.begin("ses_a", 1_000)
    LLMSessionUsage.begin("ses_b", 1_000)

    LLMSessionUsage.clear("ses_a")
    expect(LLMSessionUsage.get("ses_a")).toBeUndefined()
    expect(LLMSessionUsage.get("ses_b")).toBeDefined()

    LLMSessionUsage.clear()
    expect(LLMSessionUsage.size()).toBe(0)
  })

  test("stays bounded by evicting the least recently used session", () => {
    for (let i = 0; i < LLMSessionUsage.MAX_SESSIONS; i++) LLMSessionUsage.begin(`ses_${i}`, 1_000 + i)
    expect(LLMSessionUsage.size()).toBe(LLMSessionUsage.MAX_SESSIONS)

    LLMSessionUsage.begin("ses_new", 2_000)

    expect(LLMSessionUsage.size()).toBe(LLMSessionUsage.MAX_SESSIONS)
    expect(LLMSessionUsage.get("ses_0")).toBeUndefined()
    expect(LLMSessionUsage.get("ses_new")?.requests).toBe(1)
  })
})
