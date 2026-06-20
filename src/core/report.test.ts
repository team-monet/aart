import { describe, it, expect, afterEach } from 'vitest'
import { renderReport } from './report'
import type { RunRecord } from './types'

/** Minimal valid RunRecord fixture; override fields per test. */
function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'test-run-id',
    blockId: 'test.block',
    status: 'COMPLETED',
    inputs: {},
    trace: [],
    snapshot: { root: { id: 'test.block', name: 'Test', version: '0.1.0', inputs: [], outputs: [], execution: { type: 'node', code: 'return {};' } }, blocks: {} },
    artifacts: [],
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('renderReport — UNAPPROVED warning', () => {
  const savedEnv = process.env.AART_REQUIRE_APPROVAL

  afterEach(() => {
    // Restore env after each test that may set it.
    if (savedEnv === undefined) {
      delete process.env.AART_REQUIRE_APPROVAL
    } else {
      process.env.AART_REQUIRE_APPROVAL = savedEnv
    }
  })

  it('shows the UNAPPROVED warning when approved:false and approvalEnforced:true', () => {
    const record = makeRecord({ approved: false, approvalEnforced: true })
    expect(renderReport(record)).toContain('ran UNAPPROVED')
  })

  it('does NOT show UNAPPROVED warning when approved:false and approvalEnforced:false, even with AART_REQUIRE_APPROVAL=1 set during render', () => {
    // This is the key assertion: renderReport must not read the live env.
    process.env.AART_REQUIRE_APPROVAL = '1'
    const record = makeRecord({ approved: false, approvalEnforced: false })
    expect(renderReport(record)).not.toContain('ran UNAPPROVED')
  })

  it('does NOT show UNAPPROVED warning when approved:true', () => {
    const record = makeRecord({ approved: true, approvalEnforced: true })
    expect(renderReport(record)).not.toContain('ran UNAPPROVED')
  })

  it('does NOT show UNAPPROVED warning for legacy records missing approvalEnforced (undefined is falsy)', () => {
    // Old on-disk records have no approvalEnforced field — silent is the safe default.
    process.env.AART_REQUIRE_APPROVAL = '1'
    const record = makeRecord({ approved: false })
    expect(renderReport(record)).not.toContain('ran UNAPPROVED')
  })
})
