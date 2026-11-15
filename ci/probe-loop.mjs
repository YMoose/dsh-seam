#!/usr/bin/env node
/**
 * probe-loop.mjs — 单仓六步探测循环（真实第三方 DSH 插件仓回归 dsh-seam 工具链）。
 *
 * 两个入口共用同一实现（单一事实源，断言语义不漂移）：
 *   - 本地：dsh-plugins/probe-dsh-seam.mjs（薄包装，readdir 发现本地克隆，永不进 Git）
 *   - CI：  ci/probe-corpus.mjs + .github/workflows/real-plugin-probe.yml
 *          （按 ci/plugins.json clone → --ignore-scripts 安装 → 逐仓探测）
 *
 * 对每个插件仓执行并断言：
 *   1. 零写入 verify（Level 0）——记录基线结果（绿/红都是有效观测，不判失败）
 *   2. scan --write 补戳元数据——schemaVersion/generator/generatedAt 齐全
 *   3. 幂等——第二次 --write 输出 unchanged 且文件字节不变
 *   4. scan --check 漂移门禁绿
 *   5. verify 读戳记后的文件——结果与第 1 步基线完全一致
 *   6. 恢复原状——删掉测试期间新建的所有 coupling.json，git 脏文件数回到探测前
 *
 * 失败语义：第三方仓红脸 = 观测；只有上述我方断言或复原失败才计为 failure。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const PROVENANCE = /^(?:\d+\.\d+\.\d+(?:[-+].+)?|ref:[0-9a-f]{7,40}|unknown)$/

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
 * 对单个插件仓执行六步闭环。
 * @returns {{ row: [string, string, string, string], failures: string[], notes: string[] }}
 *   row = [名称, 状态(probed|probed*|FAILED|…), 结果摘要, 标记]
 */
export function probeRepo(repo, cli) {
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
    // 2. 补戳元数据（recursive：每个发现的插件包各写一份 coupling.json）
    step = 'scan --write'
    const write1 = run(cli, scanArgs(['--write']))
    if (write1.status !== 0 || !/written/.test(write1.out)) throw new Error(`exit=${write1.status} ${write1.out.slice(0, 200)}`)
    const stampedFiles = couplingFiles(repo)
    if (stampedFiles.length === 0) throw new Error('scan --write produced no coupling.json')
    for (const file of stampedFiles) {
      const stamped = JSON.parse(readFileSync(file, 'utf8'))
      const label = relative(repo, file)
      if (stamped.schemaVersion !== 1) throw new Error(`${label}: schemaVersion=${String(stamped.schemaVersion)}`)
      if (!PROVENANCE.test(stamped.generator?.dshSeam ?? '')) throw new Error(`${label}: generator.dshSeam=${String(stamped.generator?.dshSeam)}`)
      if (typeof stamped.generator?.typescript !== 'string' || stamped.generator.typescript === '') throw new Error(`${label}: generator.typescript missing`)
      if (!ISO.test(stamped.generatedAt ?? '')) throw new Error(`${label}: generatedAt=${String(stamped.generatedAt)}`)
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
