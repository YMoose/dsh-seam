#!/usr/bin/env node
/**
 * probe-corpus.mjs — 真实插件语料回归 runner（GitHub Actions / 本地通用）。
 *
 *   node ci/probe-corpus.mjs [--list <plugins.json>] [--workspace <dir>]
 *                            [--only name1,name2] [--report <file>]
 *
 * 流程：按 ci/plugins.json 逐仓 `git clone --depth 1` → 按锁文件识别包管理器并以
 * `--ignore-scripts` 安装依赖（第三方仓的 install 脚本禁止在我们的 runner 上执行）
 * → 复用 ci/probe-loop.mjs 的六步探测闭环。
 *
 * 失败语义：
 *   - clone 失败 = 语料列表失效 → 计为 failure（列表必须保持健康）
 *   - install 失败/超时 = 第三方仓环境问题 → 降级为 skip 观测，不计 failure
 *   - 第三方仓探针红脸 = 观测记录（写入报告），不计 failure
 *   - 六步闭环断言或复原失败 = 工具链回归 → 计为 failure，CI 判红
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeRepo, hasDshDeps } from './probe-loop.mjs'

const DSH_SEAM = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(DSH_SEAM, 'cli.mjs')

/** 工具链自身的 typescript 必须就位。payload 脚本的解析锚点优先落在 dsh-seam 自己的
 *  node_modules（本地开发机一直如此）；CI 检出后若不装依赖，解析会回退到插件仓 pin
 *  的 typescript——生态里已有 ^7.0.2（Go 原生重写，无经典 Compiler API，ts.SyntaxKind
 *  不存在）与干脆不含 typescript 的仓，两种都会崩。装不上就大声失败，不静默降级。 */
if (!existsSync(join(DSH_SEAM, 'node_modules', 'typescript'))) {
  console.log('dsh-seam dependencies missing — running npm ci (pins the verified typescript toolchain)')
  const installed = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 300_000, cwd: DSH_SEAM })
  if ((installed.status ?? 1) !== 0) {
    console.error(`cannot install dsh-seam dependencies:\n${installed.stdout}\n${installed.stderr}`)
    process.exit(2)
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const only = argValue('--only')?.split(',').map(s => s.trim()).filter(Boolean)
const listPath = resolve(argValue('--list') ?? join(DSH_SEAM, 'ci', 'plugins.json'))
const reportPath = argValue('--report')
const workspaceParent = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir()
const workspace = resolve(argValue('--workspace') ?? mkdtempSync(join(workspaceParent, 'dsh-corpus-')))

const { plugins } = JSON.parse(readFileSync(listPath, 'utf8'))
/** 条目两种形态：字符串（默认 level 0）或 { repo, level }。 */
const entries = plugins.map(entry => (typeof entry === 'string'
  ? { repo: entry, level: 0 }
  : { repo: entry.repo, level: entry.level ?? 0 }))
const selected = entries.filter(({ repo: url }) => only === undefined || only.includes(basename(url.replace(/\.git$/, ''))))
if (selected.length === 0) {
  console.error(`no plugin selected (list: ${listPath}, --only: ${String(only)})`)
  process.exit(2)
}
console.log(`corpus: ${selected.length}/${plugins.length} plugin(s) from ${listPath}`)
console.log(`workspace: ${workspace}`)
console.log(`dsh-seam: ${DSH_SEAM} (node ${process.version})\n`)

/** 按锁文件识别包管理器；无锁文件但有 package.json 时按 npm 尝试。 */
function installCommand(repo) {
  if (existsSync(join(repo, 'pnpm-lock.yaml'))) return [['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']], ['pnpm', ['install', '--ignore-scripts']]]
  if (existsSync(join(repo, 'yarn.lock'))) return [['yarn', ['install', '--frozen-lockfile', '--ignore-scripts']], ['yarn', ['install', '--ignore-scripts']]]
  if (existsSync(join(repo, 'package.json'))) return [['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']]]
  return null
}

const failures = []
const rows = []

for (const { repo: url, level } of selected) {
  const name = basename(url.replace(/\.git$/, ''))
  const repo = join(workspace, name)

  // 1. clone（--depth 1；重跑时清掉旧目录保证干净起点）
  const cloned = spawnSync('git', ['clone', '--depth', '1', url, repo], { encoding: 'utf8', timeout: 300_000 })
  if ((cloned.status ?? 1) !== 0) {
    failures.push(`${name} [clone]: ${String(cloned.stderr).trim().slice(0, 160)}`)
    rows.push([name, 'CLONE-FAILED', 'repo unreachable — prune or fix ci/plugins.json', '✖'])
    continue
  }

  // 2. 安装（第三方 install 脚本一律禁执行；失败/超时降级为 skip 观测）
  const commands = installCommand(repo)
  if (!existsSync(join(repo, 'package.json'))) {
    rows.push([name, 'skip', 'no package.json — not a plugin package', '—'])
    continue
  }
  let installed = false
  let installNote = ''
  if (commands !== null) {
    for (const [bin, args] of commands) {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 300_000, cwd: repo })
      if ((r.status ?? 1) === 0) { installed = true; break }
      installNote = `${bin} ${args.join(' ')} -> exit ${r.status} ${String(r.stderr).trim().split('\n').at(-1)?.slice(0, 120) ?? ''}`
    }
  }
  if (!installed && commands !== null) {
    console.log(`  ~ ${name}: install failed (${installNote}) — probing without dependencies`)
  }

  // 3. 按接入级别探测（0=六步闭环；1/2=接入者只读断言；无依赖时 L0 内部走 skip 路径）
  const { row, failures: repoFailures, notes } = probeRepo(repo, CLI, level)
  if (!installed && commands !== null && hasDshDeps(repo) === false) {
    row[2] = `install failed → ${row[2]}`
  }
  rows.push(row)
  failures.push(...repoFailures)
  for (const note of notes) console.log(`  ~ ${name}: ${note}`)
}

const width = [14, 14, 78, 4]
const lines = ['', '=== dsh-seam 真实插件语料回归 ===']
for (const row of rows) {
  lines.push(row.map((cell, i) => String(cell).slice(0, width[i] ?? 78).padEnd(width[i] ?? 78)).join(' '))
}
lines.push('（probed* = workspace 布局，--recursive 逐包探测；skip 行为观测记录）')
if (failures.length > 0) {
  lines.push(`\n${failures.length} failure(s):`)
  for (const failure of failures) lines.push(`  ✖ ${failure}`)
} else {
  lines.push('\nall assertions passed; every probed workspace restored')
}
const report = lines.join('\n')
console.log(report)
if (reportPath !== undefined) {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${report}\n`)
  console.log(`\nreport written to ${reportPath}`)
}
process.exit(failures.length > 0 ? 1 : 0)
