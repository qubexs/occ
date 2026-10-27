// Resolves the credential the opencode provider should actually use.
//
// `auth.json` entries and provider env vars are merged into `provider.key`
// during provider construction, but the loader's own `options` are applied
// afterwards and win the merge. Setting `apiKey` to "" there shadowed every
// stored credential, so requests fell back to the pool placeholder
// ("oauth-managed") instead of the key the user configured.
//
// Empty values fall through to the next source rather than seeding an
// unusable ring entry.
export type AuthLike =
  | { readonly type: "api"; readonly key: string }
  | { readonly type: "oauth"; readonly access: string }
  | { readonly type: "wellknown"; readonly key: string; readonly token: string }
  | undefined

export type ResolveInput = {
  readonly configKeys: readonly string[] | undefined
  readonly auth: AuthLike
  readonly envKey: string | undefined
}

export type Credential = {
  /** Entries seeded into the rotation ring. */
  readonly keys: readonly string[]
  /** Value handed to the SDK; the pool overrides Authorization per request. */
  readonly apiKey: string
  /** Whether paid models stay available. */
  readonly ok: boolean
}

export const resolve = (input: ResolveInput): Credential => {
  if (input.configKeys && input.configKeys.length > 0) {
    return { keys: input.configKeys, apiKey: input.configKeys[0]!, ok: true }
  }
  if (input.auth?.type === "api" && input.auth.key) {
    return { keys: [input.auth.key], apiKey: input.auth.key, ok: true }
  }
  if (input.auth?.type === "oauth" && input.auth.access) {
    return { keys: [input.auth.access], apiKey: input.auth.access, ok: true }
  }
  if (input.envKey) {
    return { keys: [input.envKey], apiKey: input.envKey, ok: true }
  }
  // Well-known auth carries a URL + token, not a provider key. The credential
  // is injected by the auth layer, so the ring keeps its managed placeholder.
  if (input.auth) {
    return { keys: ["oauth-managed"], apiKey: "", ok: true }
  }
  return { keys: ["public"], apiKey: "public", ok: false }
}

export const envKeyOf = (
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
  return undefined
}

export * as ProviderCredential from "./credential"
