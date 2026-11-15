#!/usr/bin/env node
/**
 * dsh-seam：面向 DSH 插件与宿主仓库的契约工具链统一入口。
 * 支持通过本地路径或 `npx github:YMoose/dsh-seam` 双轨运行：
 *
 *   轨道 A（插件仓常驻受管同步，零额外 npm 依赖轴）：
 *     sync     [--into <consumerDir>] [--source <thisRepo>]
 *     check    [--into <consumerDir>] [--source <thisRepo>]
 *
 *   轨道 B（直接运行：Level 0 零配置体检 / Level 1 显式门禁 / 多契约批量校验）：
 *     scan     [--root <repoDir>] [--write | --check | --json] [--recursive]
 *     verify   [--repo <repoDir>] [<coupling.json> ...] [--recursive]
 *     bump     [--root <repoDir>] [--check | --print-only] [--keep-floor]
 *     compat   [--root <repoDir>] [--manifest <package.json>]
 *     baseline [--root <repoDir>]
 *
 * 同步范围：payload/scripts/*.mjs 和 payload/tests/seam/*.ts 保持原相对路径；
 * payload/tests/mechanism/*.test.ts 映射到插件仓库的 tests/ 根目录，交由该仓库
 * 原有的 TypeScript 编译和测试命令执行；payload/tests/contracts/** 仅用于本仓库
 * 类型检查，从不写入插件仓库。
 *
 * 已有文件只有在内容仍与上次同步哈希一致时才允许覆盖。如果本地内容既不同于
 * 新共享文件，也不同于上次同步记录，命令会报错并停止，避免静默覆盖本地修改。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST = '.dsh-seam.json'
const DEFAULT_SOURCE = dirname(fileURLToPath(import.meta.url))
const USAGE = `usage: dsh-seam <command> [options]
  sync     [--into <consumerDir>] [--source <thisRepo>]          install/refresh the managed payload
  check    [--into <consumerDir>] [--source <thisRepo>]          verify managed files against the manifest and payload
  scan     [--root <repoDir>] [--write | --check | --json] [--recursive]  scan source coupling and implicit-contract suspects
  verify   [--repo <repoDir>] [<coupling.json> ...] [--recursive]         verify coupling contracts (scans in-memory if no coupling.json)
  bump     [--root <repoDir>] [--check | --print-only] [--keep-floor]  check or advance the @deepseek-ai/dsh-* dependency group
  compat   [--root <repoDir>] [--manifest <package.json>]        run the official @deepseek-ai/dsh-app-boot compatibility gate
  baseline [--root <repoDir>]                                    write baseline.json integrity fingerprint from node_modules`

// --- workspace 递归编排（docs/design.md 决策 15 / Phase 2.4）---------------
// 目标单位始终是插件包根；--recursive 只是显式编排层：按根 package.json 的
// workspaces 声明发现候选包，判定 = package.json 声明任意 @deepseek-ai/* 依赖，
// 发现表逐包打印判定依据（透明、可审计），对每个插件包执行既有单包流程并聚合
// 退出码。默认不递归；根自身零耦合但存在候选包时只具名引导，不代替执行。

/** package.json 各依赖节里声明的 @deepseek-ai/* 数量。 */
function countDshDeps(pkg) {
  let count = 0
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg?.[section]
    if (deps === null || typeof deps !== 'object') continue
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@deepseek-ai/')) count += 1
    }
  }
  return count
}

/** 展开 workspaces glob。支持 npm 最常见的 `<前缀>*` 尾部单段通配与无通配字面量；
 *  更复杂模式按不存在处理——发现表会如实反映展开结果。 */
function expandWorkspacePattern(rootDir, pattern) {
  const starIndex = pattern.indexOf('*')
  const isDir = path => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
  if (starIndex === -1) {
    const dir = join(rootDir, pattern)
    return isDir(dir) ? [dir] : []
  }
  if (pattern.slice(starIndex + 1) !== '') return []
  const prefix = pattern.slice(0, starIndex)
  const baseDir = prefix === '' ? rootDir : join(rootDir, prefix)
  if (!isDir(baseDir)) return []
  const out = []
  for (const name of readdirSync(baseDir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const abs = join(baseDir, name)
    if (isDir(abs)) out.push(abs)
  }
  return out
}

/** 读取根 package.json 的 workspaces 声明，产出候选插件包与判定表。 */
function discoverPluginPackages(rootDir) {
  let rootPkg = null
  try {
    rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  } catch {
    return { rootDeclared: false, candidates: [] }
  }
  const globs = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : Array.isArray(rootPkg?.workspaces?.packages)
      ? rootPkg.workspaces.packages
      : []
  const candidates = []
  const seen = new Set()
  for (const pattern of globs) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) continue
    for (const dir of expandWorkspacePattern(rootDir, pattern)) {
      if (seen.has(dir)) continue
      seen.add(dir)
      const rel = relative(rootDir, dir) || '.'
      let count = 0
      let reason = 'no @deepseek-ai/* dependency — not a DSH plugin package'
      try {
        count = countDshDeps(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
      } catch {
        reason = 'unreadable package.json — skipped'
      }
      candidates.push({ dir, rel, count, isPlugin: count > 0, reason })
    }
  }
  candidates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { rootDeclared: countDshDeps(rootPkg) > 0, candidates }
}

function printDiscoveryTable(rootDir, discovery) {
  console.log(`dsh-seam recursive: workspace plugin-package discovery under ${rootDir}`)
  if (discovery.candidates.length === 0) {
    console.log('  (no workspace packages found — nothing to recurse into)')
    return
  }
  for (const candidate of discovery.candidates) {
    const verdict = candidate.isPlugin
      ? `${candidate.count} @deepseek-ai dep(s) -> scan/verify`
      : `skip (${candidate.reason})`
    console.log(`  ${candidate.rel}  ${verdict}`)
  }
}

/** 默认（无 --recursive）时的透明引导：根自身不是插件包但子包里有候选。 */
function printGuidanceNote(discovery) {
  const pluginCandidates = discovery.candidates.filter(entry => entry.isPlugin)
  if (discovery.rootDeclared || pluginCandidates.length === 0) return
  console.log(`NOTE: this root declares no @deepseek-ai/* dependency, but ${pluginCandidates.length} workspace package(s) do:`)
  for (const candidate of pluginCandidates) console.log(`  - ${candidate.rel} (${candidate.count} @deepseek-ai dep(s))`)
  console.log('  rerun with --recursive, or point --root/--repo at the package directory (docs/design.md decision 15).')
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function resolveManagedPath(into, consumerRel) {
  if (typeof consumerRel !== 'string' || consumerRel.trim() === '' || consumerRel.includes('\0')) {
    console.error(`REFUSED: invalid managed path in ${MANIFEST}: ${JSON.stringify(consumerRel)}`)
    process.exit(1)
  }
  const root = resolve(into)
  const target = resolve(root, consumerRel)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`REFUSED: managed path escapes consumer root: ${consumerRel}`)
    process.exit(1)
  }
  return target
}

/** Consumer-relative managed pairs [payloadRel, consumerRel], deterministic order. */
function whitelist(source) {
  const entries = []
  const walk = (absolute, relative) => {
    for (const name of readdirSync(absolute).sort()) {
      const abs = join(absolute, name)
      const rel = relative === '' ? name : `${relative}/${name}`
      if (statSync(abs).isDirectory()) { walk(abs, rel); continue }
      const [area, group] = rel.split('/')
      if (area === 'scripts' && rel.endsWith('.mjs')) entries.push([rel, rel])
      else if (area === 'tests' && group === 'seam' && rel.endsWith('.ts')) entries.push([rel, rel])
      else if (area === 'tests' && group === 'mechanism' && rel.endsWith('.test.ts')) {
        entries.push([rel, `tests/${rel.split('/').slice(2).join('/')}`])
      } // tests/contracts/** stays a typecheck fixture; nothing else is managed
    }
  }
  walk(join(source, 'payload'), '')
  return entries
}

function readManifest(into) {
  const manifestPath = join(into, MANIFEST)
  if (!existsSync(manifestPath)) return undefined
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    console.error(`REFUSED: corrupt ${MANIFEST} in ${resolve(into)}: ${String(error)}`)
    process.exit(1)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.files === null || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    console.error(`REFUSED: malformed ${MANIFEST} in ${resolve(into)}: expected a JSON object with a "files" map`)
    process.exit(1)
  }
  return parsed
}

/** HEAD commit via plain .git reads, with fallback to npm/npx tarball metadata in package.json. */
function gitHead(source) {
  try {
    let gitDir = join(source, '.git')
    if (existsSync(gitDir)) {
      if (statSync(gitDir).isFile()) {
        const pointer = readFileSync(gitDir, 'utf8').trim()
        if (pointer.startsWith('gitdir: ')) gitDir = resolve(source, pointer.slice(8).trim())
      }
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
      if (!head.startsWith('ref: ')) return head
      const ref = head.slice(5).trim()
      const loose = join(gitDir, ref)
      if (existsSync(loose)) return readFileSync(loose, 'utf8').trim()
      const commonDir = existsSync(join(gitDir, 'commondir'))
        ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
        : gitDir
      const commonLoose = join(commonDir, ref)
      if (existsSync(commonLoose)) return readFileSync(commonLoose, 'utf8').trim()
      const packedPath = join(commonDir, 'packed-refs')
      if (existsSync(packedPath)) {
        for (const line of readFileSync(packedPath, 'utf8').split(/\r?\n/)) {
          if (line.startsWith('#') || line.startsWith('^') || line.trim() === '') continue
          const [sha, name] = line.trim().split(/\s+/)
          if (name === ref && sha !== undefined) return sha
        }
      }
    }
    const pkgPath = join(source, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (typeof pkg.gitHead === 'string' && pkg.gitHead.trim() !== '') return pkg.gitHead.trim()
      if (typeof pkg._resolved === 'string') {
        const match = /(?:#|\/tar\.gz\/)([0-9a-f]{7,40})\b/i.exec(pkg._resolved)
        if (match?.[1] !== undefined) return match[1]
      }
    }
    return 'unknown'
  } catch { return 'unknown' }
}

function sync(into, source) {
  const entries = whitelist(source)
  if (entries.length === 0) { console.error(`no payload files under ${join(source, 'payload')}`); process.exit(1) }
  const previous = readManifest(into)
  const hashes = {}
  const writes = []
  for (const [payloadRel, consumerRel] of entries) {
    const target = resolveManagedPath(into, consumerRel)
    const content = readFileSync(join(source, 'payload', payloadRel))
    const hash = sha256(content)
    if (existsSync(target)) {
      const current = sha256(readFileSync(target))
      if (current === hash) { hashes[consumerRel] = hash; continue } // byte-identical: no-op
      if (previous?.files?.[consumerRel] !== current) {
        console.error(`REFUSED: ${consumerRel} is locally modified (matches neither the payload nor the last synced hash) — resolve first`)
        console.error(`  last synced: ${String(previous?.files?.[consumerRel])}\n  on disk now: ${current}`)
        process.exit(1)
      }
    }
    writes.push({ consumerRel, target, content })
    hashes[consumerRel] = hash
  }
  const removals = []
  for (const [consumerRel, lastHash] of Object.entries(previous?.files ?? {})) {
    if (hashes[consumerRel] !== undefined) continue
    const target = resolveManagedPath(into, consumerRel)
    if (existsSync(target)) {
      const current = sha256(readFileSync(target))
      if (current !== lastHash) {
        console.error(`REFUSED: ${consumerRel} is no longer managed, but is locally modified (does not match the last synced hash) — resolve first`)
        console.error(`  last synced: ${String(lastHash)}\n  on disk now: ${current}`)
        process.exit(1)
      }
    }
    removals.push({ consumerRel, target })
  }
  for (const { consumerRel, target, content } of writes) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    console.log(`  + ${consumerRel}`)
  }
  for (const { consumerRel, target } of removals) {
    rmSync(target, { force: true })
    console.log(`  - ${consumerRel} (no longer managed — removed)`)
  }
  const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : 1)))
  writeFileSync(join(into, MANIFEST), `${JSON.stringify({ source: { path: resolve(source), commit: gitHead(source) }, files: sorted }, null, 2)}\n`)
  console.log(`synced ${Object.keys(sorted).length} managed file(s) into ${resolve(into)} (source ${resolve(source)}@${gitHead(source)})`)
}

function check(into, sourceOverride) {
  const manifest = readManifest(into)
  if (manifest === undefined) { console.error(`no ${MANIFEST} in ${resolve(into)} — run dsh-seam sync first`); process.exit(1) }
  const recordedEntries = Object.entries(manifest.files)
  if (recordedEntries.length === 0) {
    console.error(`  ✖ empty ${MANIFEST} in ${resolve(into)} — run dsh-seam sync`)
    process.exit(1)
  }
  const problems = []
  for (const [consumerRel, hash] of recordedEntries) {
    const target = resolveManagedPath(into, consumerRel)
    if (!existsSync(target)) problems.push(`missing managed file: ${consumerRel}`)
    else if (sha256(readFileSync(target)) !== hash) problems.push(`drift (locally modified): ${consumerRel}`)
  }
  const recordedSource = manifest.source?.path
  const source = sourceOverride
    ?? (typeof recordedSource === 'string' && existsSync(join(recordedSource, 'payload')) ? recordedSource : DEFAULT_SOURCE)
  if (typeof source !== 'string' || !existsSync(join(source, 'payload'))) {
    problems.push(`cannot locate payload source (${String(source)}) — pass --source <thisRepo> or run dsh-seam sync`)
  } else {
    const current = new Map(
      whitelist(source).map(([payloadRel, consumerRel]) => [
        consumerRel,
        sha256(readFileSync(join(source, 'payload', payloadRel))),
      ]),
    )
    for (const [consumerRel, hash] of recordedEntries) {
      if (!current.has(consumerRel)) {
        problems.push(`no longer in the payload whitelist: ${consumerRel} — run dsh-seam sync`)
      } else if (current.get(consumerRel) !== hash) {
        problems.push(`stale managed file (payload updated since last sync): ${consumerRel} — run dsh-seam sync`)
      }
    }
    for (const consumerRel of current.keys()) {
      if (manifest.files[consumerRel] === undefined) {
        problems.push(`shipped in the payload but not synced: ${consumerRel} — run dsh-seam sync`)
      }
    }
    const head = gitHead(source)
    if (sourceOverride === undefined && manifest.source?.commit !== undefined
      && manifest.source.commit !== 'unknown' && head !== 'unknown'
      && manifest.source.commit !== head) {
      problems.push(`source commit moved (${manifest.source.commit} -> ${head}) — run dsh-seam sync`)
    }
  }
  if (problems.length > 0) { for (const line of problems) console.error(`  ✖ ${line}`); process.exit(1) }
  console.log(`${resolve(into)}: ${recordedEntries.length} managed file(s) match ${MANIFEST} (source ${source}@${manifest.source?.commit})`)
}

function failUsage(message) {
  if (message !== undefined) console.error(message)
  console.log(USAGE)
  process.exit(1)
}

function parseSyncOrCheckOptions(args) {
  let into = process.cwd()
  let source
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--into' || arg === '--source') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      if (arg === '--into') into = value
      else source = value
      index += 1
    } else {
      failUsage(`unknown option: ${arg}`)
    }
  }
  return { into: resolve(into), source: source !== undefined ? resolve(source) : undefined }
}

function runPayloadScript(scriptRel, args, envOverrides = {}, stdio = 'inherit') {
  const scriptPath = join(DEFAULT_SOURCE, 'payload', scriptRel)
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    stdio,
    env: { ...process.env, ...envOverrides },
  })
  return result
}

function scanCommand(args) {
  let root = process.env.DSH_SEAM_ROOT ?? process.env.DSH_LOG_ENHANCE_ROOT ?? process.cwd()
  let recursive = false
  const forward = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--root' || arg === '--repo') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      root = value
      index += 1
    } else if (arg === '--recursive') {
      recursive = true
    } else if (arg === '--write' || arg === '--check' || arg === '--json') {
      forward.push(arg)
    } else {
      failUsage(`unknown option for scan: ${arg}`)
    }
  }
  if (recursive && forward.includes('--json')) {
    failUsage('--json cannot be combined with --recursive (a run must emit exactly one JSON document)')
  }
  const rootDir = resolve(root)
  if (recursive) {
    const discovery = discoverPluginPackages(rootDir)
    printDiscoveryTable(rootDir, discovery)
    const pluginCandidates = discovery.candidates.filter(entry => entry.isPlugin)
    if (pluginCandidates.length === 0) process.exit(0)
    let failed = false
    for (const candidate of pluginCandidates) {
      console.log(`==> scan ${candidate.rel}`)
      const result = runPayloadScript('scripts/analyze-dsh-coupling.mjs', forward, { DSH_SEAM_ROOT: candidate.dir })
      if ((result.status ?? 1) !== 0) failed = true
    }
    console.log(`recursive scan: ${pluginCandidates.length} plugin package(s), ${failed ? 'RED' : 'green'}`)
    process.exit(failed ? 1 : 0)
  }
  const result = runPayloadScript('scripts/analyze-dsh-coupling.mjs', forward, { DSH_SEAM_ROOT: rootDir })
  const status = result.status ?? 1
  if (status === 0) printGuidanceNote(discoverPluginPackages(rootDir))
  process.exit(status)
}

function verifyCommand(args) {
  let repo = process.env.DSH_SEAM_ROOT ?? process.env.DSH_LOG_ENHANCE_ROOT ?? process.cwd()
  let recursive = false
  const files = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--repo' || arg === '--root') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      repo = value
      index += 1
    } else if (arg === '--recursive') {
      recursive = true
    } else if (arg.startsWith('--')) {
      failUsage(`unknown option for verify: ${arg}`)
    } else {
      files.push(resolve(process.cwd(), arg))
    }
  }
  if (recursive && files.length > 0) {
    failUsage('--recursive cannot be combined with explicit coupling.json arguments (point --repo at the workspace root instead)')
  }
  const repoRoot = resolve(repo)
  if (files.length > 0) {
    const result = runPayloadScript('scripts/verify-coupling.mjs', files, { DSH_SEAM_ROOT: repoRoot })
    process.exit(result.status ?? 1)
  }

  /** 单包验证一次：优先已提交契约，否则内存扫描 + 免落盘验证。返回退出码。 */
  const verifyRepoOnce = (targetRoot, label) => {
    const committedCoupling = join(targetRoot, 'coupling.json')
    if (existsSync(committedCoupling)) {
      const result = runPayloadScript('scripts/verify-coupling.mjs', [committedCoupling], {
        DSH_SEAM_ROOT: targetRoot,
        ...(label !== undefined ? { DSH_SEAM_LABEL: label } : {}),
      })
      return result.status ?? 1
    }
    // Level 0 zero-config ephemeral mode: scan in memory and verify without writing to targetRoot.
    const scanned = runPayloadScript('scripts/analyze-dsh-coupling.mjs', ['--json'], { DSH_SEAM_ROOT: targetRoot }, 'pipe')
    if (scanned.status !== 0) {
      if (scanned.stderr) process.stderr.write(scanned.stderr)
      return scanned.status ?? 1
    }
    const coupling = JSON.parse(scanned.stdout)
    const fieldCount = Object.values(coupling.fieldPaths ?? {})
      .reduce((sum, paths) => sum + Object.keys(paths).length, 0)
    console.log(
      `scanned ${label ?? targetRoot} (ephemeral, 0 files written): ${Object.keys(coupling.packages ?? {}).length} package(s), `
        + `${(coupling.srcHooks ?? []).length} src hook(s), ${fieldCount} field path(s)`,
    )
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-seam-ephemeral-'))
    const tempCoupling = join(tempDir, 'coupling.json')
    writeFileSync(tempCoupling, scanned.stdout)
    try {
      const result = runPayloadScript('scripts/verify-coupling.mjs', [tempCoupling], {
        DSH_SEAM_ROOT: targetRoot,
        DSH_SEAM_LABEL: `${label ?? targetRoot} (ephemeral)`,
      })
      return result.status ?? 1
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  if (recursive) {
    const discovery = discoverPluginPackages(repoRoot)
    printDiscoveryTable(repoRoot, discovery)
    const pluginCandidates = discovery.candidates.filter(entry => entry.isPlugin)
    if (pluginCandidates.length === 0) process.exit(0)
    let failed = false
    for (const candidate of pluginCandidates) {
      console.log(`==> verify ${candidate.rel}`)
      if (verifyRepoOnce(candidate.dir, candidate.rel) !== 0) failed = true
    }
    console.log(`recursive verify: ${pluginCandidates.length} plugin package(s), ${failed ? 'RED' : 'green'}`)
    process.exit(failed ? 1 : 0)
  }
  const status = verifyRepoOnce(repoRoot)
  if (status === 0) printGuidanceNote(discoverPluginPackages(repoRoot))
  process.exit(status)
}

function bumpCommand(args) {
  let root = process.cwd()
  let hasExplicitRoot = false
  const forward = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--root' || arg === '--repo') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      root = value
      hasExplicitRoot = true
      index += 1
    } else if (arg === '--check' || arg === '--print-only' || arg === '--keep-floor') {
      forward.push(arg)
    } else {
      failUsage(`unknown option for bump: ${arg}`)
    }
  }
  const repoRoot = resolve(root)
  const envOverrides = {}
  if (hasExplicitRoot || (process.env.DSH_SEAM_MANIFEST === undefined && process.env.DSH_LOG_ENHANCE_MANIFEST === undefined)) {
    envOverrides.DSH_SEAM_MANIFEST = join(repoRoot, 'package.json')
  }
  if (hasExplicitRoot || (process.env.DSH_SEAM_BASELINE === undefined && process.env.DSH_LOG_ENHANCE_BASELINE === undefined)) {
    envOverrides.DSH_SEAM_BASELINE = join(repoRoot, 'baseline.json')
  }
  const result = runPayloadScript('scripts/bump-upstream.mjs', forward, envOverrides)
  process.exit(result.status ?? 1)
}

function compatCommand(args) {
  let root = process.cwd()
  let manifestPath
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--root' || arg === '--repo') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      root = value
      index += 1
    } else if (arg === '--manifest') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      manifestPath = value
      index += 1
    } else {
      failUsage(`unknown option for compat: ${arg}`)
    }
  }
  const resolvedManifest = manifestPath !== undefined
    ? resolve(process.cwd(), manifestPath)
    : join(resolve(root), 'package.json')
  const result = runPayloadScript('scripts/check-compat.mjs', [], { DSH_SEAM_MANIFEST: resolvedManifest })
  process.exit(result.status ?? 1)
}

function baselineCommand(args) {
  let root = process.cwd()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--root' || arg === '--repo') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      root = value
      index += 1
    } else {
      failUsage(`unknown option for baseline: ${arg}`)
    }
  }
  const repoRoot = resolve(root)
  const result = runPayloadScript('scripts/write-baseline.mjs', [], {
    DSH_SEAM_HIDDEN_LOCK: join(repoRoot, 'node_modules/.package-lock.json'),
    DSH_SEAM_BASELINE_OUT: join(repoRoot, 'baseline.json'),
  })
  process.exit(result.status ?? 1)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'sync') {
  const { into, source } = parseSyncOrCheckOptions(rest)
  sync(into, source ?? DEFAULT_SOURCE)
} else if (command === 'check') {
  const { into, source } = parseSyncOrCheckOptions(rest)
  check(into, source)
} else if (command === 'scan') {
  scanCommand(rest)
} else if (command === 'verify') {
  verifyCommand(rest)
} else if (command === 'bump') {
  bumpCommand(rest)
} else if (command === 'compat') {
  compatCommand(rest)
} else if (command === 'baseline') {
  baselineCommand(rest)
} else {
  console.log(USAGE)
  process.exit(command === '--help' || command === '-h' || command === undefined ? 0 : 1)
}
