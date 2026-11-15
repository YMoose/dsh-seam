#!/usr/bin/env node
/**
 * probe-loop.mjs — 按接入级别探测单个插件仓（真实 DSH 插件仓回归 dsh-seam 工具链）。
 *
 * 两个入口共用同一实现（单一事实源，断言语义不漂移）：
 *   - 本地：dsh-plugins/probe-dsh-seam.mjs（薄包装，readdir 发现本地克隆，永不进 Git）
 *   - CI：  ci/probe-corpus.mjs + .github/workflows/real-plugin-probe.yml
 *          （按 ci/plugins.json 的 { repo, level } clone → --ignore-scripts 安装 → 逐仓探测）
 *
 * Level 0（零接入第三方仓）执行六步闭环：
 *   1. 零写入 verify——记录基线结果（绿/红都是有效观测，不判失败）
 *   2. scan --write 补戳元数据——schemaVersion/generator/generatedAt 齐全
 *   3. 幂等——第二次 --write 输出 unchanged 且文件字节不变
 *   4. scan --check 漂移门禁绿
 *   5. verify 读戳记后的文件——结果与第 1 步基线完全一致
 *   6. 恢复原状——删掉测试期间新建的所有 coupling.json，git 脏文件数回到探测前
 *
 * Level 1/2（接入者仓）只读断言：契约在案+戳记齐全+scan --check 门禁，verify 为观测；
 * Level 2 另加 .dsh-seam.json 在案 + check --into 离线门禁 + outdated staleness 提示。
 *
 * 失败语义：第三方仓红脸 = 观测；只有上述我方断言、复原失败或「声明级别与实际
 * 状态不符」才计为 failure。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const PROVENANCE = /^(?:\d+\.\d+\.\d+(?:[-+].+)?|ref:[0-9a-f]{7,40}|unknown)$/

/** 校验一份 coupling.json 的溯源戳记；返回错误消息或 null。 */
function stampedProblems(file, repo) {
  try {
    const stamped = JSON.parse(readFileSync(file, 'utf8'))
    const label = relative(repo, file)
    if (stamped.schemaVersion !== 1) return `${label}: schemaVersion=${String(stamped.schemaVersion)}`
    if (!PROVENANCE.test(stamped.generator?.dshSeam ?? '')) return `${label}: generator.dshSeam=${String(stamped.generator?.dshSeam)}`
    if (typeof stamped.generator?.typescript !== 'string' || stamped.generator.typescript === '') return `${label}: generator.typescript missing`
    if (!ISO.test(stamped.generatedAt ?? '')) return `${label}: generatedAt=${String(stamped.generatedAt)}`
    return null
  } catch (error) {
    return `${relative(repo, file)}: unreadable (${error.message})`
  }
}

/** 与工具链同规则：从插件仓根向上找最近的 node_modules/@deepseek-ai。 */
export function hasDshDeps(root) {
  let dir = resolve(root)
  for (;;) {
    if (existsSync(join(dir, 'node_modules', '@deepseek-ai'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** workspace 插件子包判定：展开 package.json workspaces + pnpm-workspace.yaml 的
 *  glob（与 cli.mjs 的发现逻辑同源），存在「非根」且声明 @deepseek-ai 依赖的子目录
 *  时才走 --recursive；根单包仓（含 `packages: ['.']` 反爬升写法）仍按单根探测，
 *  否则只会得到根目录 0/0 的空洞绿。 */
export function workspacePluginDirs(repo) {
  const globs = []
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    if (Array.isArray(pkg.workspaces)) globs.push(...pkg.workspaces)
    else if (Array.isArray(pkg.workspaces?.packages)) globs.push(...pkg.workspaces.packages)
  } catch {}
  if (existsSync(join(repo, 'pnpm-workspace.yaml'))) {
    let inPackages = false
    for (const raw of readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trimEnd()
      if (line.trim() === '') continue
      if (/^packages:\s*$/.test(line)) { inPackages = true; continue }
      if (inPackages) {
        const entry = /^\s*-\s*(.+?)\s*$/.exec(line)
        if (entry?.[1] === undefined) break
        const glob = entry[1].replace(/^['"]|['"]$/g, '')
        if (glob !== '') globs.push(glob)
      }
    }
  }
  const isDir = path => { try { return statSync(path).isDirectory() } catch { return false } }
  const dirs = []
  for (const pattern of globs) {
    const star = pattern.indexOf('*')
    if (star === -1) {
      if (isDir(join(repo, pattern))) dirs.push(resolve(repo, pattern))
      continue
    }
    if (pattern.slice(star + 1) !== '') continue
    const base = pattern.slice(0, star) === '' ? repo : join(repo, pattern.slice(0, star))
    if (!isDir(base)) continue
    for (const name of readdirSync(base).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      if (isDir(join(base, name))) dirs.push(join(base, name))
    }
  }
  const declaresDsh = pkg => ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    .some(section => pkg?.[section] !== null && typeof pkg?.[section] === 'object'
      && Object.keys(pkg[section]).some(name => name.startsWith('@deepseek-ai/')))
  return dirs.filter(dir => resolve(dir) !== resolve(repo)
    && (() => { try { return declaresDsh(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))) } catch { return false } })())
}

/** 收集 repo 下所有 coupling.json 绝对路径（跳过 node_modules/.git）。 */
export function couplingFiles(repo) {
  const found = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name === 'coupling.json') found.push(abs)
    }
  }
  walk(repo)
  return found.sort()
}

export function gitDirty(dir) {
  return spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
    .stdout.split('\n').filter(line => line.trim() !== '').length
}

function run(cli, args, cwd) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 180_000, cwd })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

/**
 * 对单个插件仓按接入级别探测。
 * @param {0|1|2} level 语料声明的接入级别（与工具链 Level 0/1/2 同构）：
 *   0 = 零接入第三方仓 → 六步闭环（write→幂等→门禁→基线一致→复原删除）
 *   1 = 已提交 coupling.json → 契约在案+戳记断言+只读漂移门禁；verify 为观测
 *   2 = 受管同步仓 → L1 全部 + .dsh-seam.json 在案 + check --into 离线门禁绿
 *       + outdated 作 staleness 提示（note，不判红）
 * 声明级别与实际状态不符（如声明 L≥1 却无提交契约）计为 failure（配置诚实性检查）。
 * @returns {{ row: [string, string, string, string], failures: string[], notes: string[] }}
 */
export function probeRepo(repo, cli, level = 0) {
  return level >= 1 ? probeAdopted(repo, cli, level) : probeUnadopted(repo, cli)
}

/** Level 1/2（接入者仓）：只读断言为主，绝不写入或删除任何文件。 */
function probeAdopted(repo, cli, level) {
  const name = repo.split('/').pop()
  const failures = []
  const notes = []

  // 1. 契约在案 + 戳记元数据齐全
  const couplingPath = join(repo, 'coupling.json')
  if (!existsSync(couplingPath)) {
    failures.push(`${name} [L${level}]: no committed coupling.json — declared level is overstated`)
    return { row: [name, 'FAILED', `L${level} without committed coupling.json`, '✖'], failures, notes }
  }
  const stamped = stampedProblems(couplingPath, repo)
  if (stamped !== null) failures.push(`${name} [coupling.json]: ${stamped}`)

  // 2. 只读漂移门禁：提交在案的契约必须与源码一致（改源码忘更契约在此暴露）
  const check = run(cli, ['scan', '--root', repo, '--check'])
  if (check.status !== 0 || !/matches coupling\.json/.test(check.out)) {
    failures.push(`${name} [scan --check]: exit=${check.status} ${check.out.slice(0, 200)}`)
  }

  // 3. verify：结果为观测（borrowed/exempt 属正常放行；第三方红脸不判失败）
  const verified = run(cli, ['verify', '--repo', repo])
  const verifyLine = (verified.out.match(/^[^\n]*probes[^\n]*$/gm) ?? [])
    .map(line => line.replace(/^[^:]*:\s*/, '').trim()).join(' | ') || '(no probes line)'
  if (verified.status !== 0) notes.push(`verify exit=${verified.status}（观测）`)

  // 4. Level 2 专属：受管清单在案 + 离线完整性门禁 + 上游 staleness 提示
  let level2 = ''
  if (level >= 2) {
    if (!existsSync(join(repo, '.dsh-seam.json'))) {
      failures.push(`${name} [L2]: no committed .dsh-seam.json — declared level is overstated`)
    } else {
      const gate = run(cli, ['check', '--into', repo])
      if (gate.status !== 0) failures.push(`${name} [check --into]: exit=${gate.status} ${gate.out.slice(0, 200)}`)
      else level2 = 'check ✓, '
      const outdated = run(cli, ['outdated', '--into', repo])
      const firstLine = outdated.out.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' ; ')
      notes.push(`outdated: ${firstLine === '' ? '(no output)' : firstLine}`)
    }
  }

  const mark = failures.length === 0 ? '✓' : '✖'
  return {
    row: [name, `probed-L${level}`, `${level2}${verifyLine}`, mark],
    failures,
    notes,
  }
}

/** Level 0（零接入仓）：六步闭环（write→幂等→门禁→基线一致→复原删除）。 */
function probeUnadopted(repo, cli) {
  const name = repo.split('/').pop()
  const deps = hasDshDeps(repo)
  const recursive = deps && workspacePluginDirs(repo).length > 0
  const failures = []
  const notes = []

  const verifyArgs = recursive ? ['verify', '--repo', repo, '--recursive'] : ['verify', '--repo', repo]
  const baseline = run(cli, verifyArgs)
  const linesOf = text => (text.match(/^[^\n]*probes[^\n]*$/gm) ?? [])
    .map(line => line.replace(/^[^:]*:\s*/, '').trim())
  const resultOf = text => linesOf(text).join(' | ') || '(no probes line)'

  if (!deps) {
    const row = [name, 'skip', baseline.status === 0 ? 'verify skip ✓ (exit 0)' : `verify exit=${baseline.status}`, '—']
    if (baseline.status !== 0) notes.push('无 @deepseek-ai 依赖但 verify 非 0')
    return { row, failures, notes }
  }

  const scanArgs = extra => recursive
    ? ['scan', '--root', repo, ...extra, '--recursive']
    : ['scan', '--root', repo, ...extra]
  const couplingFilesBefore = new Set(couplingFiles(repo))
  const dirtyBefore = gitDirty(repo)
  let step = 'baseline'
  try {
    // 2. 补戳元数据（recursive：每个发现的插件包各写一份 coupling.json）。
    //    已提交契约的仓（Level 1/2 接入者，如 dsh-log-enhance）若契约仍最新，
    //    首跑就会输出 unchanged——同样合法，元数据断言对既有文件照常生效。
    step = 'scan --write'
    const write1 = run(cli, scanArgs(['--write']))
    if (write1.status !== 0 || !/written|unchanged/.test(write1.out)) throw new Error(`exit=${write1.status} ${write1.out.slice(0, 200)}`)
    const stampedFiles = couplingFiles(repo)
    if (stampedFiles.length === 0) throw new Error('scan --write produced no coupling.json')
    for (const file of stampedFiles) {
      const problem = stampedProblems(file, repo)
      if (problem !== null) throw new Error(problem)
    }

    // 3. 幂等（recursive：全部 coupling.json 字节不变）
    step = 'idempotent --write'
    const snapshot = new Map(couplingFiles(repo).map(file => [file, readFileSync(file, 'utf8')]))
    const mtimes = new Map([...snapshot.keys()].map(file => [file, statSync(file).mtimeMs]))
    const write2 = run(cli, scanArgs(['--write']))
    if (write2.status !== 0 || !/unchanged/.test(write2.out)) throw new Error(`exit=${write2.status} ${write2.out.slice(0, 200)}`)
    for (const [file, content] of snapshot) {
      if (readFileSync(file, 'utf8') !== content) throw new Error(`second write changed ${relative(repo, file)}`)
      if (statSync(file).mtimeMs !== mtimes.get(file)) notes.push(`${relative(repo, file)}: mtime moved despite unchanged content (cosmetic)`)
    }

    // 4. 漂移门禁
    step = 'scan --check'
    const check = run(cli, scanArgs(['--check']))
    const gateOk = check.status === 0 && (recursive
      ? /recursive scan:.*plugin/.test(check.out)
      : /matches coupling\.json/.test(check.out))
    if (!gateOk) throw new Error(`exit=${check.status} ${check.out.slice(0, 200)}`)

    // 5. 读戳记文件的 verify 必须与零写入基线一致（标签前缀不同是预期：
    //    ephemeral vs coupling.json，只比对退出码与结果部分）
    step = 'verify stamped'
    const after = run(cli, verifyArgs)
    if (after.status !== baseline.status || resultOf(after.out) !== resultOf(baseline.out)) {
      throw new Error(`stamped verify diverged from baseline:\n  baseline: exit=${baseline.status} ${resultOf(baseline.out)}\n  stamped:  exit=${after.status} ${resultOf(after.out)}`)
    }
    return { row: [name, recursive ? 'probed*' : 'probed', resultOf(after.out), '✓'], failures, notes }
  } catch (error) {
    failures.push(`${name} [${step}]: ${error.message}`)
    return { row: [name, 'FAILED', step, error.message.slice(0, 60)], failures, notes }
  } finally {
    // 6. 恢复原状（无论如何都执行）：删掉测试期间新建的所有 coupling.json
    for (const file of couplingFiles(repo)) {
      if (!couplingFilesBefore.has(file)) rmSync(file)
    }
    const dirtyAfter = gitDirty(repo)
    if (dirtyAfter !== dirtyBefore) failures.push(`${name} [restore]: dirty ${dirtyBefore} -> ${dirtyAfter}（工作区未复原）`)
  }
}
