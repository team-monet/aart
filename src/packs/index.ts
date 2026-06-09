import type { Pack } from '../pack/types'
import { qaPack } from './qa'

/** Packs loaded into every Runtime. (Later: make this configurable.) */
export const builtinPacks: Pack[] = [qaPack]
