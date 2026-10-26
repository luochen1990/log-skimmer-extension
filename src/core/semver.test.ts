// semver.test.ts — 极简 semver 比较的单元测试 (bundle 版本协商的地基)。
import { equal } from 'node:assert/strict'
import { test } from 'node:test'
import { compareSemVer, parseSemVer, semVerGte } from './semver.ts'

test('parse: 容忍缺段与 v 前缀', () => {
  equal(parseSemVer('1.2.3')?.minor, 2)
  equal(parseSemVer('v1.2.3')?.major, 1)
  equal(parseSemVer('0.1')?.patch, 0)
  equal(parseSemVer(' 2.0.0 ')?.major, 2)
  equal(parseSemVer('1.2.3.4'), null)
  equal(parseSemVer('abc'), null)
  equal(parseSemVer('1.2-beta'), null)
})

test('compare: 逐段比较', () => {
  equal(compareSemVer('0.1.0', '0.1.0'), 0)
  equal(compareSemVer('1.0.0', '0.9.9'), 1)
  equal(compareSemVer('0.9.9', '1.0.0'), -1)
  equal(compareSemVer('0.10.0', '0.9.0'), 1)
  equal(compareSemVer('0.0.2', '0.0.10'), -1)
  equal(compareSemVer('1.0', '1.0.0'), 0)
  equal(compareSemVer('x', '1.0.0'), null)
})

test('gte: 协商语义', () => {
  equal(semVerGte('0.1.0', '0.1.0'), true)
  equal(semVerGte('0.2.0', '0.1.0'), true)
  equal(semVerGte('0.1.0', '0.2.0'), false)
  equal(semVerGte('bad', '0.1.0'), null)
})
