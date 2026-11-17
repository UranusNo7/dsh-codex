/**
 * Package-owned invariant companion for `dsh-codex`.
 * @module dsh-codex/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

/** Legacy companion entry retained for existing compositions. */
export const name = 'openai-codex-invariant'
export const inject: readonly string[] = []

// Current DSH no longer ships the invariants service. This companion never
// installed checks: provider uniqueness and disposal belong to the LLM/web
// registries, and file/network validation remains in its owning operations.
export const apply = (_ctx: Context): Promise<() => void> =>
  Promise.resolve(() => {})
