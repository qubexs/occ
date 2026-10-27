import { describe, expect, test } from "bun:test"
import { LLMRequestPrep } from "../../src/session/llm/request"

describe("LLMRequestPrep.gatewayVersion", () => {
  test("reports the upstream release version a build was stamped with", () => {
    expect(LLMRequestPrep.gatewayVersion("2.1.4")).toBe("2.1.4")
    expect(LLMRequestPrep.gatewayVersion("2.1.5")).toBe("2.1.5")
    expect(LLMRequestPrep.gatewayVersion("3.0.0")).toBe("3.0.0")
  })

  test("falls back to the adapted upstream version for preview, dev and stale builds", () => {
    expect(LLMRequestPrep.gatewayVersion("local")).toBe(LLMRequestPrep.ADAPTED_OPENCODE_VERSION)
    expect(LLMRequestPrep.gatewayVersion("0.0.0-dev-202610271200")).toBe(LLMRequestPrep.ADAPTED_OPENCODE_VERSION)
    expect(LLMRequestPrep.gatewayVersion("2.1.3")).toBe(LLMRequestPrep.ADAPTED_OPENCODE_VERSION)
    expect(LLMRequestPrep.gatewayVersion("1.19.2")).toBe(LLMRequestPrep.ADAPTED_OPENCODE_VERSION)
  })
})
