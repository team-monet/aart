import type { Pack } from '../pack/types'
import { qaPack } from './qa'

/**
 * Packs compiled into the runtime, loaded into every Runtime. Workspace packs
 * (`.aa/packs/<name>` + approval in `.aa/packs.json`) are loaded on top of
 * these by `openRuntime` — see `src/pack/loader.ts`.
 */
export const builtinPacks: Pack[] = [qaPack]
