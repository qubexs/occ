import { describe, expect, test } from "bun:test"
import { ProviderCredential } from "../../src/provider/credential"

describe("ProviderCredential.resolve", () => {
  test("configured keys win and rotate", () => {
    const credential = ProviderCredential.resolve({
      configKeys: ["key-a", "key-b"],
      auth: { type: "api", key: "auth-key" },
      envKey: "env-key",
    })

    expect(credential).toEqual({ keys: ["key-a", "key-b"], apiKey: "key-a", ok: true })
  })

  test("uses an api key from auth.json", () => {
    const credential = ProviderCredential.resolve({
      configKeys: undefined,
      auth: { type: "api", key: "auth-key" },
      envKey: undefined,
    })

    expect(credential).toEqual({ keys: ["auth-key"], apiKey: "auth-key", ok: true })
  })

  test("uses an oauth access token from auth.json", () => {
    const credential = ProviderCredential.resolve({
      configKeys: undefined,
      auth: { type: "oauth", access: "access-token" },
      envKey: undefined,
    })

    expect(credential).toEqual({ keys: ["access-token"], apiKey: "access-token", ok: true })
  })

  test("uses a provider env key when nothing else is stored", () => {
    const credential = ProviderCredential.resolve({ configKeys: undefined, auth: undefined, envKey: "env-key" })

    expect(credential).toEqual({ keys: ["env-key"], apiKey: "env-key", ok: true })
  })

  test("auth.json wins over the env var", () => {
    const credential = ProviderCredential.resolve({
      configKeys: undefined,
      auth: { type: "api", key: "auth-key" },
      envKey: "env-key",
    })

    expect(credential.apiKey).toBe("auth-key")
  })

  test("wellknown auth keeps the managed placeholder", () => {
    const credential = ProviderCredential.resolve({
      configKeys: undefined,
      auth: { type: "wellknown", key: "EXAMPLE_KEY", token: "token" },
      envKey: undefined,
    })

    expect(credential).toEqual({ keys: ["oauth-managed"], apiKey: "", ok: true })
  })

  test("falls back to the public placeholder without any credential", () => {
    const credential = ProviderCredential.resolve({ configKeys: undefined, auth: undefined, envKey: undefined })

    expect(credential).toEqual({ keys: ["public"], apiKey: "public", ok: false })
  })

  test("treats an empty configured list as unset", () => {
    const credential = ProviderCredential.resolve({ configKeys: [], auth: undefined, envKey: "env-key" })
    expect(credential.apiKey).toBe("env-key")
  })

  test("treats an empty stored key as missing", () => {
    const credential = ProviderCredential.resolve({
      configKeys: undefined,
      auth: { type: "api", key: "" },
      envKey: undefined,
    })

    expect(credential).toEqual({ keys: ["oauth-managed"], apiKey: "", ok: true })
  })
})

describe("ProviderCredential.envKeyOf", () => {
  test("returns the first non-empty env var in provider order", () => {
    expect(
      ProviderCredential.envKeyOf(["OPENCODE_MISSING", "OPENCODE_API_KEY", "OPENCODE_FALLBACK"], {
        OPENCODE_MISSING: undefined,
        OPENCODE_API_KEY: "key",
        OPENCODE_FALLBACK: "other",
      }),
    ).toBe("key")
  })

  test("returns undefined when none are set", () => {
    expect(ProviderCredential.envKeyOf(["A", "B"], { A: "", B: undefined })).toBeUndefined()
  })
})
