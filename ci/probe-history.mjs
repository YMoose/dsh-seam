#!/usr/bin/env node
/**
 * probe-history.mjs — 历史适配回放：用真实插件仓的版本迭代提交当 ground truth，
 * 校验 verify --upstream 的检测能力（design.md 2.5 的实战检验）。
 *
 * 两种模式：
 *   --discover [--only a,b] [--max N]   在本地克隆（dsh-plugins/）上自动发现
 *                                       「适配提交」（锁文件里 DSH 系列版本变化的
 *                                       first-parent 提交），跑三点矩阵并产出
 *                                       可入库的候选 JSON（离线填表工具）。
 *   --check [--list ci/plugins.json] [--workspace <dir>] [--only a,b] [--report <file>]
 *                                       跑 plugins.json 里 curated 的 history
 *                                       断言（CI 模式，全量 clone + 按锁文件
 *                                       --ignore-scripts 安装后回放；--report
 *                                       额外写文件供 artifact 上传）。
 *
 * 三点矩阵（P = 适配前提交，C = 适配后提交，V1 = dshFrom，V2 = dshTo）：
 *   F(code, V) = 该代码对版本 V 验证时的失败表面集合（✖ 行按表面归一化）。
 *   NEW   = F(P, V2) − F(P, V1) —— 工具检测到的「新版本新增破坏」
 *   FIXED = NEW ∩ F(C, V2)     —— 其中在适配后提交上仍未修复的
 * 断言语义（curated 案例，expect 字段）：两类都锁工具行为、偏离判红——
 *   expect "detected"：verdict = validated（NEW ≠ ∅ 且 FIXED = ∅）——工具检测到了
 *                      作者当时面对的真实破坏（战果）；
 *   expect "routine"： verdict = routine（NEW = ∅）——升级未破坏锚定面，工具
 *                      正确判定兼容（误报回归同样会在这里暴露）。
 * 存量红脸（P 在 dshFrom 上本来就红的表面）不参与判定——只有「因升级而新增 /
 * 因适配而消失」的表面算数。
 *
 * 失败语义：工具崩溃、装配失败、commit/版本腐烂（哈希找不到、registry 无该版本）
 * 或 curated 断言偏离 → failure；第三方仓自身的红脸一律是观测。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCommand, workspacePluginDirs } from './probe-loop.mjs'

const DSH_SEAM = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(DSH_SEAM, 'cli.mjs')

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
function git(repo, args, options = {}) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 60_000, ...options })
}
function show(repo, ref, file) {
  const result = git(repo, ['show', `${ref}:${file}`])
  return result.status === 0 ? result.stdout : null
}

/** 某提交上锁文件解析出的 DSH 系列包版本集合（lockstep 校验用）。
 *  返回 null 表示无锁文件或锁类型暂不支持（yarn）。 */
function dshVersionsAt(repo, ref) {
  const pnpm = show(repo, ref, 'pnpm-lock.yaml')
  if (pnpm !== null) {
    const versions = new Set()
    for (const match of pnpm.matchAll(/^\s*'@deepseek-ai\/(dsh[a-z0-9-]*)@([^':()]+)':\s*$/gm)) versions.add(match[2])
    return versions
  }
  const npm = show(repo, ref, 'package-lock.json')
  if (npm !== null) {
    try {
      const lock = JSON.parse(npm)
      const versions = new Set()
      for (const key of Object.keys(lock.packages ?? {})) {
        if (!key.startsWith('node_modules/@deepseek-ai/dsh') && key !== 'node_modules/@deepseek-ai/dsh') continue
        const version = lock.packages[key]?.version
        if (typeof version === 'string') versions.add(version)
      }
      return versions
    } catch { return null }
  }
  return null
}

/** 对 worktree 跑 verify --upstream <version>，返回 { exit, surfaces }。
 *  surfaces = 失败表面集合（✖ 行去掉 (at …)/(line N) 位置后缀的归一化标题）。
 *  验证真正完成时输出必含「probes compile clean」判定行；缺失说明装配失败
 *  （--upstream 拉包 notarget / cannot fetch 等），此时抛错而非返回空集——
 *  空集会让差集运算退化成假 routine（dsh-image-pathify 首轮实测的坑）。
 *  workspace 判定只用 workspacePluginDirs（读子包 package.json 的 dsh 声明，
 *  不依赖 node_modules——历史回放不装依赖，DSH 系列由 --upstream 遮蔽）；
 *  不能叠加 probe-loop 的 hasDshDeps（它只认物理 node_modules/@deepseek-ai，
 *  全新 clone 上恒 false，会把 pnpm workspace 仓打成单仓路径、根目录扫出
 *  空包集而 failUsage——agentero 首轮 check 的实测）。 */
function verifyAt(worktree, version) {
  const recursive = workspacePluginDirs(worktree).length > 0
  const args = recursive
    ? ['verify', '--repo', worktree, '--recursive', '--upstream', version]
    : ['verify', '--repo', worktree, '--upstream', version]
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 300_000 })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!output.includes('probes compile clean')) {
    const cause = output.split('\n').find(line => /cannot fetch|notarget|no @deepseek-ai|usage:|cannot scan|cannot list/i.test(line))
      ?? `verify --upstream ${version} produced no verdict line (exit ${result.status})`
    throw new Error(`assembly failed: ${cause.slice(0, 140)}`)
  }
  const surfaces = new Set()
  for (const line of output.split('\n')) {
    if (!line.trimStart().startsWith('✖')) continue
    surfaces.add(line.trim().replace(/\s*\(at [^)]*\)\s*$/, '').replace(/\s*\(line \d+\)\s*$/, '').trim())
  }
  return { exit: result.status, surfaces, output }
}

/** 给 worktree 挂 ref 并软链 node_modules（依赖装在主克隆上；DSH 系列会被
 *  --upstream 遮蔽，本地装什么版本无所谓，cordis 等沿用 HEAD 安装）。 */
function attachWorktree(repo, ref, dir) {
  const added = git(repo, ['worktree', 'add', '--detach', dir, ref])
  if (added.status !== 0) throw new Error(`worktree add ${ref} failed: ${String(added.stderr).trim().slice(0, 160)}`)
  if (existsSync(join(repo, 'node_modules')) && !existsSync(join(dir, 'node_modules'))) {
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir')
  }
}

/** 跑一个案例的三点矩阵。返回 { verdict, new: [...], fixed: [...], details }。 */
function runCase(repo, from, to, dshFrom, dshTo) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
  try {
    const pDir = join(workspace, 'P')
    const cDir = join(workspace, 'C')
    attachWorktree(repo, from, pDir)
    attachWorktree(repo, to, cDir)
    const pAtFrom = verifyAt(pDir, dshFrom)
    const pAtTo = verifyAt(pDir, dshTo)
    const cAtTo = verifyAt(cDir, dshTo)
    const newSurfaces = [...pAtTo.surfaces].filter(surface => !pAtFrom.surfaces.has(surface))
    const fixed = newSurfaces.filter(surface => cAtTo.surfaces.has(surface))
    const verdict = newSurfaces.length > 0 && fixed.length === 0 ? 'validated'
      : newSurfaces.length === 0 ? 'routine'
        : 'incomplete'
    return { verdict, newSurfaces, fixed, details: { pAtFrom: pAtFrom.exit, pAtTo: pAtTo.exit, cAtTo: cAtTo.exit } }
  } finally {
    git(repo, ['worktree', 'remove', '--force', join(workspace, 'P')], { timeout: 30_000 })
    git(repo, ['worktree', 'remove', '--force', join(workspace, 'C')], { timeout: 30_000 })
    rmSync(workspace, { recursive: true, force: true })
  }
}

/* ---------------- discover：本地填表 ---------------- */
function discover() {
  const pluginsRoot = resolve(DSH_SEAM, '..', 'dsh-plugins')
  if (!existsSync(pluginsRoot)) {
    console.error(`discover mode expects local clones at ${pluginsRoot} (dsh-plugins/ next to dsh-seam/)`)
    process.exit(2)
  }
  const only = argValue('--only')?.split(',').map(s => s.trim()).filter(Boolean)
  const maxCommits = Number(argValue('--max') ?? 400)
  const candidates = []
  for (const name of readdirSync(pluginsRoot).sort()) {
    const repo = join(pluginsRoot, name)
    if (!existsSync(join(repo, '.git')) || (only !== undefined && !only.includes(name))) continue
    const chain = git(repo, ['rev-list', '--first-parent', '--max-count', String(maxCommits), 'HEAD'])
    if (chain.status !== 0) continue
    const commits = chain.stdout.trim().split('\n').filter(Boolean)
    const versionSets = new Map()
    const versionAt = ref => {
      if (!versionSets.has(ref)) versionSets.set(ref, dshVersionsAt(repo, ref))
      return versionSets.get(ref)
    }
    const pairs = []
    for (let index = 0; index + 1 < commits.length; index += 1) {
      const current = versionAt(commits[index])
      const parent = versionAt(commits[index + 1])
      if (current === null || parent === null || parent.size === 0) continue
      // 两端都必须 lockstep 单版本：过渡态（并存多个 dsh 版本）的取值不确定，
      // dshFrom/dshTo 会退化成 Set 的任意元素——跳过而非猜。
      if (current.size > 1 || parent.size > 1) continue
      if (![...current].every(version => parent.has(version))) {
        pairs.push({ to: commits[index], from: commits[index + 1], dshTo: [...current][0], dshFrom: [...parent][0] })
      }
    }
    if (pairs.length === 0) { console.log(`${name.padEnd(20)} (无适配提交对)`); continue }
    console.log(`${name.padEnd(20)} ${pairs.length} 个适配提交对，逐个回放…`)
    for (const pair of pairs) {
      const subject = git(repo, ['log', '-1', '--format=%s', pair.to]).stdout.trim().slice(0, 52)
      try {
        const outcome = runCase(repo, pair.from, pair.to, pair.dshFrom, pair.dshTo)
        const mark = outcome.verdict === 'validated' ? '★' : outcome.verdict === 'routine' ? '·' : '?'
        console.log(`  ${mark} ${pair.to.slice(0, 8)} ${pair.dshFrom} -> ${pair.dshTo}  ${subject}`)
        console.log(`     P@from=${outcome.details.pAtFrom} P@to=${outcome.details.pAtTo} C@to=${outcome.details.cAtTo}`
          + ` | NEW=${outcome.newSurfaces.length} FIXED=${outcome.fixed.length}`)
        for (const surface of outcome.newSurfaces.slice(0, 3)) console.log(`       + ${surface.slice(0, 100)}`)
        if (outcome.verdict === 'validated' || outcome.verdict === 'routine') {
          // 两类都可入库：detected（战果）/ routine（正确判兼容，误报回归的锚）
          candidates.push({
            repo: name, from: pair.from, to: pair.to, dshFrom: pair.dshFrom, dshTo: pair.dshTo,
            expect: outcome.verdict === 'validated' ? 'detected' : 'routine',
            note: subject,
          })
        }
      } catch (error) {
        console.log(`  ✖ ${pair.to.slice(0, 8)} ${pair.dshFrom} -> ${pair.dshTo}  回放失败: ${error.message.slice(0, 120)}`)
      }
    }
  }
  if (candidates.length > 0) {
    console.log(`\n=== 可入库候选（validated→expect detected / routine→expect routine）===`)
    console.log(JSON.stringify(candidates, null, 2))
  }
}

/* ---------------- check：CI 断言 ---------------- */
function check() {
  const listPath = resolve(argValue('--list') ?? join(DSH_SEAM, 'ci', 'plugins.json'))
  const reportPath = argValue('--report') === undefined ? null : resolve(argValue('--report'))
  const only = argValue('--only')?.split(',').map(s => s.trim()).filter(Boolean)
  const workspaceParent = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir()
  const workspace = resolve(argValue('--workspace') ?? mkdtempSync(join(workspaceParent, 'dsh-histci-')))
  const { plugins } = JSON.parse(readFileSync(listPath, 'utf8'))
  const failures = []
  const rows = []
  for (const entry of plugins) {
    const name = basename(entry.repo.replace(/\.git$/, ''))
    if (entry.history === undefined || (only !== undefined && !only.includes(name))) continue
    const repo = join(workspace, name)
    if (!existsSync(repo)) {
      mkdirSync(workspace, { recursive: true })
      // 历史回放需要完整历史（corpus 探测的 --depth 1 不够）
      const cloned = spawnSync('git', ['clone', entry.repo, repo], { encoding: 'utf8', timeout: 300_000 })
      if ((cloned.status ?? 1) !== 0) {
        failures.push(`${name} [clone]: ${String(cloned.stderr).trim().slice(0, 140)}`)
        continue
      }
    }
    // 安装依赖（一律 --ignore-scripts）：--upstream 只遮蔽 DSH 系列，cordis 等
    // 独立包仍需本地解析；不装则探针的独立包 import 全部 TS2307、类型级联失真，
    // 与 discover（软链本地 node_modules）形态不可比。安装失败 = 无法回放，
    // 与 commit 腐烂同语义判红（提示修剪该条 history）。
    if (!existsSync(join(repo, 'node_modules'))) {
      let installed = false
      const notes = []
      for (const [bin, args] of installCommand(repo)) {
        const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 600_000, cwd: repo,
          env: { ...process.env, npm_config_ignore_scripts: 'true' } })
        if ((result.status ?? 1) === 0) { installed = true; break }
        notes.push(`${bin} ${args.join(' ')} -> exit ${result.status}`)
      }
      if (!installed) {
        failures.push(`${name} [install]: ${notes.join('; ').slice(0, 160)} — cannot replay without local resolution for independent packages; prune or fix this history entry`)
        continue
      }
    }
    for (const [index, testCase] of entry.history.entries()) {
      const expect = testCase.expect ?? 'detected'
      if (expect !== 'detected' && expect !== 'routine') {
        failures.push(`${name}#${index}: unknown expect "${expect}" (use "detected" or "routine")`)
        continue
      }
      const label = `${name}#${index} ${testCase.dshFrom} -> ${testCase.dshTo} [${expect}]`
      for (const ref of [testCase.from, testCase.to]) {
        if (git(repo, ['cat-file', '-e', `${ref}^{commit}`]).status !== 0) {
          failures.push(`${label}: commit ${ref} not found — fixture rot (history rebase?)`)
        }
      }
      if (failures.some(f => f.startsWith(`${label}:`))) { rows.push([label, 'ROT', 'commit missing', '✖']); continue }
      try {
        const outcome = runCase(repo, testCase.from, testCase.to, testCase.dshFrom, testCase.dshTo)
        const ok = expect === 'detected' ? outcome.verdict === 'validated' : outcome.verdict === 'routine'
        rows.push([label, ok ? 'PASS' : outcome.verdict.toUpperCase(),
          `NEW=${outcome.newSurfaces.length} FIXED=${outcome.fixed.length}`, ok ? '✓' : '✖'])
        if (!ok) {
          failures.push(`${label}: assertion deviated — expected ${expect}, got ${outcome.verdict}`
            + ` (NEW=${outcome.newSurfaces.length}, FIXED=${outcome.fixed.length})`)
          for (const surface of outcome.fixed) failures.push(`${label}: still broken after the fix: ${surface.slice(0, 120)}`)
        }
      } catch (error) {
        rows.push([label, 'FAILED', error.message.slice(0, 60), '✖'])
        failures.push(`${label}: ${error.message.slice(0, 160)}`)
      }
    }
  }
  const lines = []
  lines.push('=== dsh-seam 历史适配回放（curated 断言） ===')
  for (const [label, verdict, detail, mark] of rows) lines.push(`${mark} ${label.padEnd(46)} ${verdict.padEnd(12)} ${detail}`)
  if (failures.length > 0) {
    lines.push(`\n${failures.length} failure(s):`)
    for (const failure of failures) lines.push(`  ✖ ${failure}`)
  }
  if (rows.length === 0) lines.push('(no curated history cases configured)')
  else lines.push(failures.length === 0 ? '\nall curated history assertions hold' : '')
  const text = lines.filter(line => line !== '').join('\n')
  console.log(text)
  if (reportPath !== null) writeFileSync(reportPath, `${text}\n`)
  if (failures.length > 0) process.exit(1)
}

if (process.argv.includes('--discover')) discover()
else check()
