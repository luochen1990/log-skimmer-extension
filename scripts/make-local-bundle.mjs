// make-local-bundle.mjs — 规则仓 checkout → 跨仓契约格式 bundle (dev 工具)。
// 输出格式 (SSOT = rules 仓生成管线, 此处仅按同构契约构造本地开发/测试用副本):
//   { manifest: {format_version, min_engine_version, rule_count, generated_at},
//     rules: [{id, path, yaml}] }
// 用法: node scripts/make-local-bundle.mjs <rulesDir> <outJson>
//   <rulesDir> = log-skimmer-rules 仓的工作副本 (含子目录 *.yaml)
// 收集语义镜像 engine load_rules: 递归 *.yaml|*.yml, 跳隐藏路径与 manifest.yaml, 按路径排序。
// 注意: 产出的 bundle 是 fixture (供 e2e 与离线开发), 运行时真实来源见 src/config.ts RULES_BUNDLE_URL。
import fs from 'node:fs'
import path from 'node:path'

const [rulesDir, outJson] = process.argv.slice(2)
if (!rulesDir || !outJson) {
  console.error('usage: node scripts/make-local-bundle.mjs <rulesDir> <outJson>')
  process.exit(1)
}

function collect(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collect(p, out)
    else if (e.name === 'manifest.yaml') continue
    else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) out.push(p)
  }
}

const files = []
collect(rulesDir, files)
files.sort()

const rules = files.map((p) => {
  const yaml = fs.readFileSync(p, 'utf8')
  const id = /^id:\s*(\S+)/m.exec(yaml)?.[1]
  if (!id) throw new Error(`rule without id: ${p}`)
  return { id, path: path.relative(rulesDir, p), yaml }
})
const ids = new Set(rules.map((r) => r.id))
if (ids.size !== rules.length) throw new Error('duplicate rule ids in bundle')

const manifestPath = path.join(rulesDir, 'manifest.yaml')
const rawManifest = fs.existsSync(manifestPath)
  ? Object.fromEntries(
      fs
        .readFileSync(manifestPath, 'utf8')
        .split('\n')
        .filter((l) => /^\w+:/.test(l))
        .map((l) => {
          const i = l.indexOf(':')
          return [
            l.slice(0, i).trim(),
            l
              .slice(i + 1)
              .trim()
              .replace(/^['"]|['"]$/g, ''),
          ]
        }),
    )
  : {}
// 数值字段类型强制: yaml 文本解析产出 string, 跨仓契约要求 number (与 M2 管线 JSON 产出对齐)
if (rawManifest.format_version !== undefined) {
  rawManifest.format_version = Number(rawManifest.format_version)
}
const manifest = { min_engine_version: '0.1.0', ...rawManifest }
manifest.rule_count = rules.length
manifest.generated_at = new Date().toISOString().slice(0, 10)

fs.writeFileSync(outJson, JSON.stringify({ manifest, rules }, null, 1))
console.log(`bundle: ${rules.length} rules -> ${outJson} (${fs.statSync(outJson).size} B)`)
console.log(`manifest: ${JSON.stringify(manifest)}`)
