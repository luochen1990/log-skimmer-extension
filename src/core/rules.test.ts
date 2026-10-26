// rules.test.ts — bundle 校验/版本协商/wasm 入参格式的单元测试 (跨仓契约消费侧)。
import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import type { RulesBundle } from '../types.ts'
import { rulesJsonForWasm, validateBundle } from './rules.ts'

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest: {
      format_version: 2,
      min_engine_version: '0.1.0',
      rule_count: 1,
      generated_at: '2026-10-26',
      ...overrides,
    },
    rules: [{ id: 'r1', path: 'tool/r1.yaml', yaml: 'id: r1\n' }],
  }
}

test('validateBundle: 合法 bundle 通过并规范化', () => {
  const v = validateBundle(bundle(), '0.1.0')
  equal(v.ok, true)
  if (v.ok) equal(v.bundle.manifest.format_version, 2)
})

test('validateBundle: format_version 不匹配 → 拒收', () => {
  const v = validateBundle(bundle({ format_version: 3 }), '0.1.0')
  equal(v.ok, false)
  if (!v.ok) equal(v.reason.includes('format_version'), true)
})

test('validateBundle: min_engine_version 高于本构建 → 拒收 (版本协商)', () => {
  const v = validateBundle(bundle({ min_engine_version: '0.2.0' }), '0.1.0')
  equal(v.ok, false)
  if (!v.ok) equal(v.reason.includes('engine'), true)
})

test('validateBundle: 非法 semver → 拒收 (宁拒勿错)', () => {
  equal(validateBundle(bundle({ min_engine_version: 'x.y.z' }), '0.1.0').ok, false)
})

test('validateBundle: 结构违例逐项拒收', () => {
  equal(validateBundle(null, '0.1.0').ok, false)
  equal(validateBundle({}, '0.1.0').ok, false)
  equal(validateBundle({ manifest: bundle().manifest, rules: [] }, '0.1.0').ok, false)
  equal(validateBundle({ manifest: bundle().manifest, rules: [{ id: 'a' }] }, '0.1.0').ok, false)
  // rule_count 与 rules.length 不一致 → 拒收 (M2 管线契约)
  const mismatched = bundle({ rule_count: 2 })
  equal(validateBundle(mismatched, '0.1.0').ok, false)
  // 重复 id → 拒收
  const dup = {
    manifest: { format_version: 2, min_engine_version: '0.1.0', rule_count: 2, generated_at: 'x' },
    rules: [
      { id: 'r1', path: 'a.yaml', yaml: 'a' },
      { id: 'r1', path: 'b.yaml', yaml: 'b' },
    ],
  }
  equal(validateBundle(dup, '0.1.0').ok, false)
})

test('rulesJsonForWasm: [[path, yaml]] 形态 (ABI 契约)', () => {
  const b: RulesBundle = {
    manifest: { format_version: 2, min_engine_version: '0.1.0', rule_count: 2, generated_at: 'x' },
    rules: [
      { id: 'a', path: 't/a.yaml', yaml: 'id: a' },
      { id: 'b', path: 't/b.yaml', yaml: 'id: b' },
    ],
  }
  deepEqual(JSON.parse(rulesJsonForWasm(b)), [
    ['t/a.yaml', 'id: a'],
    ['t/b.yaml', 'id: b'],
  ])
})
