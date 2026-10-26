// rules.test.ts — bundle 校验/版本协商/wasm 入参格式的单元测试 (跨仓契约消费侧)。
import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import { GM_KEYS } from '../config.ts'
import type { GmEnv } from '../gm.ts'
import type { RulesBundle } from '../types.ts'
import { RulesStore, rulesJsonForWasm, validateBundle } from './rules.ts'

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

test('validate: 合法 bundle 通过并规范化', () => {
  const v = validateBundle(bundle(), '0.1.0')
  equal(v.ok, true)
  if (v.ok) equal(v.bundle.manifest.format_version, 2)
})

test('validate: format_version 不匹配 → 拒收 (含高于本构建)', () => {
  const v = validateBundle(bundle({ format_version: 3 }), '0.1.0')
  equal(v.ok, false)
  if (!v.ok) equal(v.reason.includes('format_version'), true)
})

test('validate: min_engine_version 高于本构建 → 拒收 (版本协商, 文案报两侧实际值)', () => {
  const v = validateBundle(bundle({ min_engine_version: '0.2.0' }), '0.1.0')
  equal(v.ok, false)
  if (!v.ok) {
    equal(v.reason.includes('engine'), true)
    equal(v.reason.includes('0.2.0'), true)
    equal(v.reason.includes('0.1.0'), true)
  }
})

test('validate: 非法 semver → 拒收 (宁拒勿错, 报实际值)', () => {
  const v = validateBundle(bundle({ min_engine_version: 'x.y.z' }), '0.1.0')
  equal(v.ok, false)
  if (!v.ok) equal(v.reason.includes('x.y.z'), true)
})

test('validate: 可选键省略 → 放行 (契约 "无则省略该键", 引擎同语义)', () => {
  // 生产契约: 规则集 manifest.yaml 未声明则 bundle 不携带 — 消费侧不得拒收
  const noMin = structuredClone(bundle()) as { manifest: Record<string, unknown> }
  delete noMin.manifest.min_engine_version
  equal(validateBundle(noMin, '0.1.0').ok, true)
  const noFmt = structuredClone(bundle()) as { manifest: Record<string, unknown> }
  delete noFmt.manifest.format_version
  equal(validateBundle(noFmt, '0.1.0').ok, true)
})

test('validate: 可选键存在但类型损坏 → 拒收 (升级门不得被绕过)', () => {
  // min_engine_version 的唯一职责是挡旧引擎 — null/number 形态静默放行 = 门失效
  const numMin = bundle({ min_engine_version: 999 })
  const v = validateBundle(numMin, '0.1.0')
  equal(v.ok, false)
  if (!v.ok) equal(v.reason.includes('999'), true)
})

test('validate: 结构违例逐项拒收', () => {
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

test('RulesStore.invalidateCache: 作废 GM bundle 键 (缓存投毒自愈, M2)', async () => {
  const store = new Map<string, string>()
  const gm: GmEnv = {
    getValue: async (k) => store.get(k),
    setValue: async (k, v) => {
      store.set(k, v)
    },
    deleteValue: async (k) => {
      store.delete(k)
    },
    crossOriginFetch: async () => {
      throw new Error('unused in this test')
    },
    managed: true,
  }
  await gm.setValue(GM_KEYS.bundle, JSON.stringify({ bundle: bundle(), fetchedAt: 0 }))
  await new RulesStore(gm, '0.1.0').invalidateCache()
  equal(await gm.getValue(GM_KEYS.bundle), undefined)
})
