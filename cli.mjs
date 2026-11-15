#!/usr/bin/env node
/**
 * dsh-seam：面向 DSH 插件与宿主仓库的契约工具链统一入口。
 * 支持通过本地路径或 `npx github:YMoose/dsh-seam` 双轨运行：
 *
 *   轨道 A（插件仓常驻受管同步，零额外 npm 依赖轴）：
 *     sync     [--into <consumerDir>] [--source <thisRepo>]   —— 写入受管文件与可移植清单
 *                                                             （source.repo + source.ref + 哈希，无本机路径）
 *     check    [--into <consumerDir>]                        —— 纯离线门禁：只比对受管文件哈希
 *     outdated [--into <consumerDir>]                        —— 联网提示上游新版本（advisory，永不阻断）
 *
 *   轨道 B（直接运行：Level 0 零配置体检 / Level 1 显式门禁 / 多契约批量校验）：
 *     scan     [--root <repoDir>] [--write | --check | --json] [--recursive]
 *     verify   [--repo <repoDir>] [<coupling.json> ...] [--recursive] [--types-root <dir> | --upstream <ver|tag>]
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
import { fileURLToPath, pathToFileURL } from 'node:url'

const MANIFEST = '.dsh-seam.json'
const DEFAULT_SOURCE = dirname(fileURLToPath(import.meta.url))
const USAGE = `usage: dsh-seam <command> [options]
  sync     [--into <consumerDir>] [--source <thisRepo>]          install/refresh the managed payload
  check    [--into <consumerDir>]                                offline gate: managed files match the manifest hashes
  outdated [--into <consumerDir>]                                advisory upstream version notice (never blocks)
  scan     [--root <repoDir>] [--write | --check | --json] [--recursive]  scan source coupling and implicit-contract suspects
  verify   [--repo <repoDir>] [<coupling.json> ...] [--recursive] [--types-root <dir> | --upstream <ver|tag>]  verify coupling contracts (scans in-memory if no coupling.json; --types-root pins the upstream .d.ts set, --upstream fetches one from the registry)
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

/** pnpm-workspace.yaml 的 `packages:` glob 列表（pnpm 在 DSH 插件生态常见，
 *  且 package.json 可完全不写 workspaces——不读它就会发现不了任何子包）。
 *  只解析最常见形态：`packages:` 顶行 + 后续 `- <glob>` 条目；其余按空处理。 */
function pnpmWorkspaceGlobs(rootDir) {
  const yamlPath = join(rootDir, 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) return []
  const globs = []
  let inPackages = false
  for (const rawLine of readFileSync(yamlPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue }
    if (inPackages) {
      const entry = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (entry?.[1] === undefined) break // 遇到下一个键：packages 列表结束
      const glob = entry[1].replace(/^['"]|['"]$/g, '')
      if (glob !== '') globs.push(glob)
    }
  }
  return globs
}

/** 读取根 package.json 的 workspaces 声明，产出候选插件包与判定表。 */
function discoverPluginPackages(rootDir) {
  let rootPkg = null
  try {
    rootPkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  } catch {
    return { rootDeclared: false, candidates: [] }
  }
  const globs = [
    ...(Array.isArray(rootPkg?.workspaces)
      ? rootPkg.workspaces
      : Array.isArray(rootPkg?.workspaces?.packages)
        ? rootPkg.workspaces.packages
        : []),
    ...pnpmWorkspaceGlobs(rootDir),
  ]
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

/** HEAD commit via plain .git reads, with fallback to npm/npx tarball metadata in
 *  package.json. Returns null when unresolvable — callers must fail loudly and
 *  never record a placeholder like 'unknown' (design.md Phase 2.0). */
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
    return null
  } catch { return null }
}

/** origin URL via `git remote get-url`, falling back to package.json repository/_resolved
 *  metadata for npx tarball checkouts. Returns null when unresolvable. */
function gitRemoteUrl(source) {
  const probed = spawnSync('git', ['-C', source, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  if (probed.status === 0 && typeof probed.stdout === 'string' && probed.stdout.trim() !== '') {
    return probed.stdout.trim()
  }
  const pkgPath = join(source, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const repository = pkg.repository
    if (typeof repository === 'string' && repository.trim() !== '') return repository.trim()
    if (typeof repository?.url === 'string' && repository.url.trim() !== '') return repository.url.trim()
    if (typeof pkg._resolved === 'string') return pkg._resolved
  } catch {}
  return null
}

/** Normalize a git remote / repository field to a portable https URL.
 *  scp-like and ssh forms collapse to https; `git+` prefixes and `.git` suffixes
 *  drop off; codeload tarball URLs map back to their repository page. Anything
 *  not URL-like (e.g. a local path used as a test remote) stays verbatim. */
function normalizeRepoUrl(url) {
  const raw = url.trim()
  let candidate = raw.replace(/^git\+/, '')
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(candidate)
  if (scp?.[1] !== undefined && scp[2] !== undefined) candidate = `https://${scp[1]}/${scp[2]}`
  else if (candidate.startsWith('ssh://')) {
    const ssh = /^ssh:\/\/[^/@]+@([^/:]+)(?::\d+)?\/(.+)$/.exec(candidate)
    if (ssh?.[1] !== undefined && ssh[2] !== undefined) candidate = `https://${ssh[1]}/${ssh[2]}`
  }
  // ssh.github.com 是 GitHub 的 SSH-over-443 端点而非 https 主机——归一化到
  // github.com，否则清单里的 source.repo 在 CI 等环境不可达（outdated 只能跳过）。
  if (/^https:\/\/ssh\.github\.com\//.test(candidate)) {
    candidate = candidate.replace(/^https:\/\/ssh\.github\.com\//, 'https://github.com/')
  }
  candidate = candidate.replace(/\.git$/, '')
  if (!/^https?:\/\//.test(candidate)) {
    if (/^[\w.-]+\/[\w.-]+$/.test(candidate)) candidate = `https://github.com/${candidate}`
    else return raw
  }
  return candidate.replace(
    /^https:\/\/codeload\.github\.com\/([\w.-]+)\/([\w.-]+)\/tar\.gz\/.*$/,
    'https://github.com/$1/$2',
  )
}

/** The repo recorded in the manifest: normalized origin URL, or null. */
function resolveSourceRepo(source) {
  const url = gitRemoteUrl(source)
  return url === null ? null : normalizeRepoUrl(url)
}

/** Human-facing repo label: `owner/name` for URLs, verbatim for other forms. */
function displayRepo(repo) {
  return repo.replace(/^https?:\/\/[^/]+\//, '')
}

const shortRef = ref => ref.slice(0, 7)

/** Semver comparison for tags (design.md decision 16): tags are parsed into
 *  concrete versions before any comparison; unparseable tags never rank.
 *  Returns positive when a > b, negative when a < b, 0 on equality. */
function compareSemver(a, b) {
  const parse = tag => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag)
    return match === null ? null : {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] === undefined ? [] : match[4].split('.'),
    }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index]
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1 // release > prerelease
  if (right.pre.length === 0) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNum = /^\d+$/.test(l) ? Number(l) : null
    const rNum = /^\d+$/.test(r) ? Number(r) : null
    if (lNum !== null && rNum !== null) { if (lNum !== rNum) return lNum - rNum; continue }
    if (lNum !== null) return -1 // numeric identifiers rank below alphanumeric
    if (rNum !== null) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/** --upstream 的逐包版本决策（design.md 2.5）：目标版本存在则 lockstep 使用；
 *  包已退出 lockstep（目标版本未发布——真实语料：@deepseek-ai/dsh-client-runtime
 *  停更于 0.1.1-rc.2，而其余包升 0.2.x）时回落到 **不超前于目标的** 最高已发布
 *  版本并由调用方打印明示（超前回落会把未来版本的破坏混进本次评估）；该包
 *  连一个 ≤ 目标的版本都没有（比目标还新）或一个版本都没发过时返回 null，
 *  由调用方按整体失败处理。 */
export function pickUpstreamVersion(target, versions) {
  const published = [...versions]
  if (published.includes(target)) return { version: target, fellBack: false }
  let best = null
  for (const version of published) {
    if (compareSemver(version, target) > 0) continue
    if (best === null || compareSemver(version, best) > 0) best = version
  }
  return best === null ? null : { version: best, fellBack: true }
}

function sync(into, source) {
  const entries = whitelist(source)
  if (entries.length === 0) { console.error(`no payload files under ${join(source, 'payload')}`); process.exit(1) }
  const ref = gitHead(source)
  if (ref === null) {
    console.error(`REFUSED: cannot resolve the dsh-seam source commit (no .git HEAD and no tarball metadata in package.json) — sync from a git clone or a published tarball`)
    process.exit(1)
  }
  const repo = resolveSourceRepo(source)
  if (repo === null) {
    console.error(`REFUSED: cannot resolve the dsh-seam source repository (no git origin and no repository/_resolved in package.json) — sync from a git clone or add a repository field`)
    process.exit(1)
  }
  const previous = readManifest(into)
  const previousRef = typeof previous?.source?.ref === 'string' ? previous.source.ref
    : typeof previous?.source?.commit === 'string' ? previous.source.commit : undefined
  if (previousRef !== undefined && previousRef !== ref && /^[0-9a-f]{7,40}$/i.test(previousRef) && /^[0-9a-f]{7,40}$/i.test(ref)) {
    // 同步状态归 sync 管（决策 7）：上一次 sync 以来源仓前进了多少，此处提示并更新。
    const counted = spawnSync('git', ['-C', source, 'rev-list', '--count', `${previousRef}..${ref}`], { encoding: 'utf8' })
    const behind = counted.status === 0 ? counted.stdout.trim() : ''
    console.log(`~ previous sync ${shortRef(previousRef)} was ${/^\d+$/.test(behind) ? `${behind} commit(s) ` : ''}behind HEAD ${shortRef(ref)} — updating`)
  }
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
  writeFileSync(join(into, MANIFEST), `${JSON.stringify({ source: { repo, ref }, files: sorted }, null, 2)}\n`)
  console.log(`synced ${Object.keys(sorted).length} managed file(s) into ${resolve(into)} (pinned to ${displayRepo(repo)}@${shortRef(ref)})`)
}

/** 纯离线门禁（决策 7）：只回答「消费仓自己的受管文件有没有被本地修改」。
 *  不定位 dsh-seam 源仓、不联网、不做新旧比对——同步状态归 sync、上游版本归 outdated。
 *  有阻断权力的检查只允许基于消费仓自身、离线且确定。 */
function check(into) {
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
  if (problems.length > 0) { for (const line of problems) console.error(`  ✖ ${line}`); process.exit(1) }
  const repo = manifest.source?.repo
  const ref = manifest.source?.ref ?? manifest.source?.commit
  if (repo === undefined) {
    console.log(`~ legacy ${MANIFEST} (no source.repo recorded) — re-run dsh-seam sync to stamp repo@ref provenance`)
  }
  const pinned = typeof repo === 'string' && typeof ref === 'string'
    ? ` (pinned to ${displayRepo(repo)}@${shortRef(ref)})`
    : typeof ref === 'string' ? ` (pinned to ${shortRef(ref)})` : ''
  console.log(`${resolve(into)}: ${recordedEntries.length} managed file(s) match ${MANIFEST}${pinned}`)
}

/** 联网版本提醒（决策 7）：`git ls-remote` 读上游 HEAD 与 semver 最新 tag（决策 16：
 *  tag 先解析成具体版本号再比较）。advisory 输出不具备阻断权力——网络不可达只提示
 *  跳过，永远 exit 0；仅用法错误（无清单）允许非零退出。 */
function outdated(into) {
  const manifest = readManifest(into)
  if (manifest === undefined) { console.error(`no ${MANIFEST} in ${resolve(into)} — run dsh-seam sync first`); process.exit(1) }
  const repo = manifest.source?.repo
  const ref = manifest.source?.ref ?? manifest.source?.commit
  if (typeof repo !== 'string' || repo.trim() === '') {
    console.log(`~ legacy ${MANIFEST} (no source.repo recorded) — re-run dsh-seam sync first`)
    return
  }
  console.log(`pinned: ${displayRepo(repo)}${typeof ref === 'string' ? `@${shortRef(ref)}` : ' (no ref recorded)'}`)
  const remote = spawnSync('git', ['ls-remote', repo], { encoding: 'utf8', timeout: 30_000 })
  if (remote.status !== 0 || typeof remote.stdout !== 'string') {
    console.log(`outdated: version check skipped (cannot reach ${repo})`)
    return
  }
  const refs = new Map()
  for (const line of remote.stdout.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/)
    if (sha !== undefined && name !== undefined) refs.set(name, sha)
  }
  const head = refs.get('HEAD')
  if (head === undefined) {
    console.log(`outdated: version check skipped (no HEAD advertised by ${repo})`)
    return
  }
  if (typeof ref === 'string' && ref === head) console.log('up to date with the upstream default branch')
  else console.log(`upstream has moved (upstream HEAD ${shortRef(head)}) — run dsh-seam sync to update`)
  const tags = []
  for (const name of refs.keys()) {
    if (!name.startsWith('refs/tags/')) continue
    const tag = name.slice('refs/tags/'.length).replace(/\^\{\}$/, '')
    if (/^v?\d+\.\d+\.\d+/.test(tag) && !tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > 0) {
    const latest = tags.reduce((best, tag) => (compareSemver(tag, best) > 0 ? tag : best))
    const latestSha = refs.get(`refs/tags/${latest}^{}`) ?? refs.get(`refs/tags/${latest}`) ?? ''
    // ls-remote 只见指针不见历史：只有 pinned 与 HEAD/tag 指针重合时才能断言顺序。
    const relation = typeof ref !== 'string' || latestSha !== ref
      ? (ref === head ? '; pinned ref is ahead of the latest tag' : '; pinned ref is not the latest tag')
      : '; pinned ref is the latest tag'
    console.log(`latest tag: ${latest}${relation}`)
  }
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

/** check/outdated 的参数边界：只接受 --into。check 是纯离线门禁（决策 7），
 *  连接源仓的 --source 都不允许出现——防止悄悄重新引入对 dsh-seam 源仓的依赖。 */
function parseIntoOptions(args, command) {
  let into = process.cwd()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--into') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      into = value
      index += 1
    } else {
      failUsage(`unknown option for ${command}: ${arg} (only --into is accepted here)`)
    }
  }
  return resolve(into)
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

/** coupling（对象）里引用过的 DSH 系列包集合：@deepseek-ai/dsh 与 dsh-*。
 *  coupling 的键可能带深导入子路径（如 `@deepseek-ai/dsh-session-projection/types`，
 *  真实语料 dsh-context 逮住的形状），先归一化到根包名再过滤。
 *  cordis 等独立版本包不参与 lockstep 换版本（design.md 2.5：沿用本地安装）。 */
function rootPackageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function dshSeriesPackagesOf(coupling) {
  const names = new Set([
    ...Object.keys(coupling?.packages ?? {}),
    ...Object.keys(coupling?.fieldPaths ?? {}),
    ...Object.keys(coupling?.discriminants ?? {}),
  ].map(rootPackageName))
  return [...names]
    .filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    .sort()
}

/** 读取插件仓 `package.json` 的 `dsh.client.inject` 模块声明（design.md 2.8）：
 *  纯 JS / manifest 注入形态唯一可见的耦合来源（源码无 import，类型契约不
 *  覆盖）。返回排序去重后的模块名；无声明、无 package.json 或文件损坏时
 *  返回空数组（调用方以此区分「无此形态」与「读取失败」无需报错）。 */
export function manifestInjectModulesOf(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const inject = manifest?.dsh?.client?.inject
    if (!Array.isArray(inject)) return []
    return [...new Set(inject.filter(name => typeof name === 'string' && name !== ''))].sort()
  } catch {
    return []
  }
}

/** 对 `client.inject` 模块做 registry 存在性检查（design.md 2.8）：这些模块
 *  由宿主运行时注入、无探针消费、无版本语义，因此只 `npm view` 确认仍在
 *  registry 上（上游改名/下架显式报错），不参与 lockstep pack。runView 由
 *  调用方注入（真实场景 spawn `npm view <name> version --json`；测试注入
 *  假 runner 离线验证判定与报错内容）。返回 null = 全部存在。 */
export function verifyInjectModulesOnRegistry(modules, runView) {
  for (const [name, repos] of modules) {
    const view = runView(name)
    if (view.status !== 0 || String(view.stdout ?? '').trim() === '' || String(view.stdout ?? '').trim() === 'undefined') {
      return `manifest dsh.client.inject module '${name}' (declared in ${repos.join(', ')}) is not found on the npm registry — `
        + `upstream may have renamed or unpublished it; update dsh.client.inject in that package.json\n${view.stderr ?? ''}`
    }
  }
  return null
}

/** 装配 --upstream 临时 types-root（design.md 2.5）：对 coupling 引用的全部
 *  DSH 系列包以同一版本 lockstep 拉取（npm pack 走 npm 自身配置——尊重
 *  registry 镜像、代理与登录态；tar 解包到 <dir>/@deepseek-ai/<pkg>），进程
 *  退出时清理。tag 输入先解析成具体版本号再使用（决策 16：tag 只用于跟随，
 *  判断一律具体版本）。任何一步失败都大声退出并保留原因。
 *  纯 manifest 形态（仅 client.inject 声明、零 lockstep 包）：存在性检查
 *  通过后返回 null——调用方以无 types-root 方式继续，verify 走自己的
 *  skip/零锚定判定路径（design.md 2.7/2.8）。 */
function buildUpstreamTypesRoot(repoRoots, spec) {
  const names = new Set()
  for (const root of repoRoots) {
    const committed = join(root, 'coupling.json')
    let coupling = null
    if (existsSync(committed)) {
      try {
        coupling = JSON.parse(readFileSync(committed, 'utf8'))
      } catch (error) {
        failUsage(`cannot parse ${committed}: ${error.message}`)
      }
    } else {
      // Level 0 仓没有已提交契约：内存扫描取包集合（离线，不写盘）。
      const scanned = runPayloadScript('scripts/analyze-dsh-coupling.mjs', ['--json'], { DSH_SEAM_ROOT: root }, 'pipe')
      if (scanned.status !== 0) {
        if (scanned.stderr) process.stderr.write(scanned.stderr)
        failUsage(`cannot scan ${root} to collect the --upstream package set`)
      }
      coupling = JSON.parse(scanned.stdout)
    }
    for (const name of dshSeriesPackagesOf(coupling)) names.add(name)
  }
  // manifest 注入模块（design.md 2.8）：纯 JS / manifest 注入形态的唯一可见
  // 耦合声明。不进 lockstep 装配（无探针消费、无版本语义），只做 registry
  // 存在性检查——上游改名/下架在装配阶段显式报错，而不是等用户面板空白。
  const injectModules = new Map()
  for (const root of repoRoots) {
    for (const name of manifestInjectModulesOf(root)) {
      const repos = injectModules.get(name) ?? []
      repos.push(root)
      injectModules.set(name, repos)
    }
  }
  if (names.size === 0 && injectModules.size === 0) {
    failUsage('--upstream found no @deepseek-ai/dsh-* packages in the coupling — nothing to pin (use --types-root to point at a prepared directory instead)')
  }
  if (injectModules.size > 0) {
    const injectFailure = verifyInjectModulesOnRegistry(
      injectModules,
      name => spawnSync('npm', ['view', name, 'version', '--json'], { encoding: 'utf8', timeout: 60_000 }),
    )
    if (injectFailure !== null) failUsage(injectFailure)
    console.log(`==> upstream: manifest-injected module(s) verified present on the registry: ${[...injectModules.keys()].sort().join(', ')}`)
  }
  if (names.size === 0) return null
  const listed = [...names].sort()
  let version = spec
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(spec)) {
    const view = spawnSync('npm', ['view', listed[0], 'dist-tags', '--json'], { encoding: 'utf8', timeout: 60_000 })
    if (view.status !== 0) failUsage(`cannot resolve tag '${spec}' (npm view ${listed[0]} dist-tags):\n${view.stderr}`)
    let tags = {}
    try { tags = JSON.parse(view.stdout) } catch { /* fall through to the not-found message */ }
    const resolved = tags?.[spec]
    if (typeof resolved !== 'string') {
      failUsage(`tag '${spec}' not found on ${listed[0]}; available dist-tags: ${Object.keys(tags).join(', ') || '(none)'}`)
    }
    version = resolved
    console.log(`==> upstream: tag '${spec}' -> ${version} (resolved via ${listed[0]} dist-tags)`)
  }
  const typesRoot = mkdtempSync(join(tmpdir(), 'dsh-upstream-'))
  let failure = null
  const versionsCache = new Map()
  const resolved = []
  for (const name of listed) {
    if (failure !== null) break
    // 逐包版本决策：npm view versions 一次拿全（缓存共享），目标版本缺版时
    // 回落到不超前于目标的最高已发布版本并明示（决策 18 语义：lockstep 只约束
    // 还参与 lockstep 的包；退出者保持 ≤ 目标的最新形态，即插件作者环境里
    // 它的真实形态，超前回落会把未来版本的破坏混进本次评估）。
    if (!versionsCache.has(name)) {
      const view = spawnSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8', timeout: 60_000 })
      if (view.status !== 0) {
        failure = `cannot list versions of ${name} (npm view ${name} versions):\n${view.stderr}`
        break
      }
      try { versionsCache.set(name, JSON.parse(view.stdout)) } catch { versionsCache.set(name, []) }
    }
    const picked = pickUpstreamVersion(version, versionsCache.get(name))
    if (picked === null) {
      failure = `${name} has no published version <= ${version} — cannot assemble an upstream types-root for it (package newer than the target, or nothing published)`
      break
    }
    if (picked.fellBack) {
      console.log(`==> upstream: ${name} has no ${version}; falling back to its latest published ${picked.version} (package left the lockstep cohort)`)
    }
    const packVersion = picked.version
    const target = join(typesRoot, '@deepseek-ai', name.slice('@deepseek-ai/'.length))
    mkdirSync(target, { recursive: true })
    const packed = spawnSync('npm', ['pack', `${name}@${packVersion}`, '--pack-destination', typesRoot], { encoding: 'utf8', timeout: 180_000 })
    const tarball = String(packed.stdout.trim().split('\n').pop())
    if (packed.status !== 0 || !tarball.endsWith('.tgz') || !existsSync(join(typesRoot, tarball))) {
      failure = `cannot fetch ${name}@${packVersion} via npm pack:\n${packed.stderr ?? ''}`
        + `— DSH-series packages are pulled in lockstep at one version; confirm every package in the coupling published ${packVersion}`
      break
    }
    const extracted = spawnSync('tar', ['-xzf', join(typesRoot, tarball), '--strip-components=1', '-C', target], { encoding: 'utf8', timeout: 60_000 })
    rmSync(join(typesRoot, tarball), { force: true })
    if (extracted.status !== 0) {
      failure = `cannot extract ${name}@${packVersion}: ${extracted.stderr}`
      break
    }
    resolved.push(`${name}@${packVersion}`)
  }
  if (failure !== null) {
    rmSync(typesRoot, { recursive: true, force: true })
    failUsage(failure)
  }
  console.log(`==> upstream types-root: ${resolved.join(', ')}`)
  process.on('exit', () => rmSync(typesRoot, { recursive: true, force: true }))
  return typesRoot
}

function verifyCommand(args) {
  let repo = process.env.DSH_SEAM_ROOT ?? process.env.DSH_LOG_ENHANCE_ROOT ?? process.cwd()
  let recursive = false
  let typesRoot
  let upstreamSpec
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
    } else if (arg === '--types-root') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      typesRoot = resolve(process.cwd(), value)
      if (!existsSync(typesRoot)) failUsage(`--types-root directory not found: ${typesRoot}`)
      index += 1
    } else if (arg === '--upstream') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) failUsage(`missing value for ${arg}`)
      upstreamSpec = value
      index += 1
    } else if (arg.startsWith('--')) {
      failUsage(`unknown option for verify: ${arg}`)
    } else {
      files.push(resolve(process.cwd(), arg))
    }
  }
  if (recursive && files.length > 0) {
    failUsage('--recursive cannot be combined with explicit coupling.json arguments (point --repo at the workspace root instead)')
  }
  if (typesRoot !== undefined && upstreamSpec !== undefined) {
    failUsage('--types-root and --upstream are mutually exclusive (--upstream assembles its own temporary types-root)')
  }
  const repoRoot = resolve(repo)
  let typesRootDir = typesRoot
  if (upstreamSpec !== undefined) {
    const targets = recursive
      ? discoverPluginPackages(repoRoot).candidates.filter(entry => entry.isPlugin).map(entry => entry.dir)
      : [repoRoot]
    if (targets.length === 0) failUsage('--upstream found no plugin packages under --repo (--recursive discovery came back empty)')
    // null = 纯 manifest 形态：存在性检查已过、无 lockstep 面可装配，不带
    // types-root 继续（verify 走 skip/零锚定判定）。
    typesRootDir = buildUpstreamTypesRoot(targets, upstreamSpec) ?? undefined
  }
  const typesRootArgs = typesRootDir === undefined ? [] : ['--types-root', typesRootDir]
  if (files.length > 0) {
    const result = runPayloadScript('scripts/verify-coupling.mjs', [...typesRootArgs, ...files], { DSH_SEAM_ROOT: repoRoot })
    process.exit(result.status ?? 1)
  }

  /** 单包验证一次：优先已提交契约，否则内存扫描 + 免落盘验证。返回退出码。 */
  const verifyRepoOnce = (targetRoot, label) => {
    const committedCoupling = join(targetRoot, 'coupling.json')
    if (existsSync(committedCoupling)) {
      const result = runPayloadScript('scripts/verify-coupling.mjs', [...typesRootArgs, committedCoupling], {
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
      const result = runPayloadScript('scripts/verify-coupling.mjs', [...typesRootArgs, tempCoupling], {
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

// ESM main guard：cli.mjs 作为模块被测试 import 时不执行命令分发（spawn 运行不受影响）。
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'sync') {
    const { into, source } = parseSyncOrCheckOptions(rest)
    sync(into, source ?? DEFAULT_SOURCE)
  } else if (command === 'check') {
    check(parseIntoOptions(rest, 'check'))
  } else if (command === 'outdated') {
    outdated(parseIntoOptions(rest, 'outdated'))
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
}
