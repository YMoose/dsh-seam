# dsh-seam

**为 DSH（DeepSeek Harness）插件把关上游兼容性——自动提取插件对 DSH 相关依赖的真实调用契约，在上游迭代或插件发版前第一时间拦截破坏性变更。**

`dsh-seam` 扫描插件源码实际用到的上游字段、事件 hook 与注入服务，生成契约快照 `coupling.json` 并对照当前安装的依赖版本逐项验证；同时提供上游依赖组同步升级与 `engines.dsh` 版本兼容范围校验。支持零配置直接运行，无需向仓库写入文件，也无需安装任何额外依赖：

```sh
# 零配置快速检查（不向仓库写入任何文件，直接验证当前仓库与已安装 DSH 依赖的兼容性）
npx github:YMoose/dsh-seam#v0.1.0 verify --repo .
```

典型输出：

```text
scanned /path/to/plugin (ephemeral, 0 files written): 14 package(s), 3 src hook(s), 29 field path(s)
/path/to/plugin (ephemeral): 28/29 probes compile clean, 1 borrowed surface(s)
  ~ borrowed (signed via inject): @deepseek-ai/cordis::skills — TS2339 (2 sites)
  ✖ [auto/field] @deepseek-ai/dsh-agent :: session (at src/observer.ts:167)
    TS2322: Type 'Session | undefined' is not assignable to type 'Session'.
```

---

## 目录

1. [核心设计思想](#1-核心设计思想)
2. [CLI 命令与同步文件速查](#2-cli-命令与同步文件速查)
3. [渐进式接入指南（Level 0 / 1 / 2）](#3-渐进式接入指南level-0--1--2)
4. [模块划分与功能架构](#4-模块划分与功能架构)
5. [检查边界与职责划分](#5-检查边界与职责划分)
6. [本仓库开发与设计文档](#6-本仓库开发与设计文档)

---

## 1. 核心设计思想

`dsh-seam` **按插件的实际调用来生成并验证上游接口契约**（即消费方驱动契约测试。工具链围绕四项机制设计，分别解决仅靠插件自身 `tsc --noEmit` 与常规依赖更新工具（Renovate / Dependabot）无法覆盖的问题：

1. **从源码提取真实调用契约，并检查字段是否被改为空值**（[原则 1、6](docs/design.md#原则-1契约由插件的真实调用定义)）
   不维护手写的上游接口列表，而是直接扫描插件源码实际读取的字段路径、注册的事件 hook 和前置类型收窄条件（`if` / `switch` / `&&` / `for...of`）；对未加空值保护（如 `?.`、`!` 或空值判断）的直接字段读取，自动记录非空约束（`pin: true`）。所有豁免与跨插件服务调用均在终端具名列出，不设静默 `// ignore` 注释。这样既能在 PR 中直观看到新增了哪些上游字段依赖，也能在插件未单独跑完整类型检查、或上游将原本非空的字段改成可空（`T` → `T | undefined`）时，精确指出受影响的源码位置。
2. **将依赖关系保存为 `coupling.json`，支持脱离插件源码独立验证**（[原则 5](docs/design.md#原则-5契约文件couplingjson是可独立验证的跨仓快照)）
   将插件对 DSH 相关依赖的调用关系保存为数 KB 的结构化契约文件 `coupling.json`；验证时由引擎自动生成对应的 TypeScript 类型检查代码（探针）并调用编译器验证。这打破了“必须克隆并配齐完整插件构建环境才能做兼容性检查”的限制，仅凭一份 `coupling.json` 就能在任意版本的上游 `.d.ts` 类型声明上快速完成验证。
3. **区分显式类型声明、跨插件服务借用与类型断言，分类检查不误报**（[原则 4、7](docs/design.md#原则-7只对显式声明的依赖报错跨插件借用只识别不误报)）
   生成类型检查代码时，只加载插件显式声明的类型；借此区分跨插件动态注入的 `Context` 服务（`borrowed`），并将绕过静态类型检查的写法（如 `as` 类型断言、`: string` 字面量拓宽、无类型 `JsonValue` 读取）归入隐含依赖检查，支持按接入深度选择“仅提示”或“强制绑定运行时测试”。这解决了 Cordis 动态插件架构下“跨插件注入与局部 `as` 断言在编译期不报错、直到运行时才崩溃”的问题，同时避免对合法的跨插件服务调用产生误报。
4. **工具零依赖分发，并配套上游依赖组同步与重发检测**（[原则 2、3](docs/design.md#原则-2引擎与共享文件不含特定插件的业务逻辑)）
   工具代码不包含任何特定插件的业务规则，通过 GitHub Tag 支持直接运行与同步脚本到仓库两种方式，不在插件仓 `package.json` 中引入任何额外 npm 依赖；同时提供 `@deepseek-ai/dsh-*` 依赖组同版本同步升级与包内容哈希（`integrity`）比对，解决上游 `next` 预发布版本高频迭代、子包 `latest` 标签滞后以及“版本号不变但重新发包”导致的依赖不一致问题。

---

## 2. CLI 命令与同步文件速查

### 2.1 CLI 命令速查

```text
usage: dsh-seam <command> [options]
```

| 使用方式 | 命令与参数 | 功能说明 |
| --- | --- | --- |
| **直接运行** | `scan [--root <dir>] [--write \| --check \| --json] [--recursive]` | 扫描源码依赖面与潜在隐含依赖；默认打印 Markdown 报告，`--write` 写入 `coupling.json`，`--check` 校验契约是否漏更新及隐含依赖是否已登记，`--recursive` 对 workspace 内全部插件包逐个执行并汇总退出码 |
| **直接运行** | `verify [--repo <dir>] [<coupling.json> ...] [--recursive] [--types-root <dir> \| --upstream <ver\|tag>]` | 生成类型检查代码并验证契约兼容性；若仓库内尚无 `coupling.json`，则在内存中直接扫描并验证；`--recursive` 逐个验证 workspace 插件包；`--types-root` 把上游 `.d.ts` 锚定到显式目录（离线），`--upstream <版本号\|tag>` 从 registry 按同版本（lockstep）拉取 DSH 系列包装配临时类型目录——用于升级前评估“升到目标版本会坏哪里”，tag 先解析为具体版本号，已退出 lockstep 的包（目标版本未发布）自动回落到不超前于目标的最新已发布版并明示，cordis 等独立包沿用本地安装 |
| **直接运行** | `bump [--root <dir>] [--check \| --print-only] [--keep-floor]` | 检查（`--check`）或统一升级 `@deepseek-ai/dsh-*` 依赖组与 `engines.dsh` 版本范围 |
| **直接运行** | `compat [--root <dir>] [--manifest <package.json>]` | 调用 `@deepseek-ai/dsh-app-boot` 官方接口校验 `engines.dsh` 版本兼容范围配置是否正确 |
| **直接运行** | `baseline [--root <dir>]` | 提取 `node_modules` 中已安装 `@deepseek-ai/*` 的版本与 `integrity` 哈希写入 `baseline.json` |
| **仓库同步** | `sync [--into <consumerDir>] [--source <thisRepo>]` | 将共享脚本与测试文件同步到插件仓库，并写入可移植的 `.dsh-seam.json` 清单（repo + ref + 哈希） |
| **仓库同步** | `check [--into <consumerDir>]` | 纯离线门禁：校验插件仓库中的受管文件哈希与 `.dsh-seam.json` 清单是否一致（不依赖源仓、不联网） |
| **仓库同步** | `outdated [--into <consumerDir>]` | advisory 提示上游默认分支与最新 tag 相对当前 pin 的状态（联网，永不阻断退出） |

### 2.2 `sync` 同步文件清单（`payload/` 映射）

执行 `sync` 将脚本同步到插件仓库时（对应 [§3.4](#34-level-2完整契约测试套件受管文件同步--隐含依赖运行时测试) 的完整接入模式），`payload/` 下的文件按以下路径写入插件仓库：

| 本仓库路径（相对 `payload/`） | 插件仓库目标路径 | 角色说明 |
| --- | --- | --- |
| `tests/seam/engine.ts` | `tests/seam/engine.ts` | 契约检查引擎：生成类型检查代码、调用 TypeScript Compiler API 编译、按属性链逐段归因报错（`SegmentDisposition`）、加载真实 `Context` 实例与注册测试套件 |
| `tests/seam/standard-specs.ts` | `tests/seam/standard-specs.ts` | 规格合并工具：`standardSpecs(coupling, implicitSeams, library?)` 将插件仓自定义的补充规则与 `coupling.json` 合并（共享文件本身不含特定插件规则） |
| `scripts/analyze-dsh-coupling.mjs` | `scripts/analyze-dsh-coupling.mjs` | AST 依赖扫描与隐含依赖检查脚本（对应 `scan`） |
| `scripts/verify-coupling.mjs` | `scripts/verify-coupling.mjs` | 独立契约编译验证脚本（对应 `verify`） |
| `scripts/bump-upstream.mjs` | `scripts/bump-upstream.mjs` | `@deepseek-ai/dsh-*` 依赖组与 `engines.dsh` 同步升级脚本（对应 `bump`） |
| `scripts/write-baseline.mjs` | `scripts/write-baseline.mjs` | `baseline.json` 包内容哈希生成脚本（对应 `baseline`） |
| `scripts/check-compat.mjs` | `scripts/check-compat.mjs` | `engines.dsh` 版本兼容范围校验脚本（对应 `compat`） |
| `tests/mechanism/*.test.ts` | `tests/*.test.ts` | 工具链自身机制的回归测试（随插件仓测试命令一起运行） |

---

## 3. 渐进式接入指南（Level 0 / 1 / 2）

检查严格度与接入深度成正比（[design.md 原则 4](docs/design.md#原则-4检查严格度与接入深度成正比三级渐进接入)）。插件可根据自身阶段选择接入方式，随时平滑升级：

> **目标单位（[design.md 决策 15](docs/design.md#4-关键架构决策记录)）**：`scan` / `verify` 的操作目标是插件包根目录——单包仓库即仓库根目录；使用 npm workspaces 等依赖提升布局（依赖装在 monorepo 根目录的 `node_modules`，子包下没有 `node_modules`）时，会自动向上查找最近的 `node_modules/@deepseek-ai`。若插件位于 monorepo 子目录，可将 `--root` / `--repo` 指向该子包目录（如 `packages/socket`），或直接在 monorepo 根目录加上 `--recursive` 自动发现并逐包检查所有声明了 `@deepseek-ai/*` 依赖的插件包。

> **版本固定约定**：以下示例统一使用 `#v0.1.0`。在首个正式 tag 发布前，请替换为具体提交哈希 `#<commit-sha>` 或本地克隆路径 `node /path/to/dsh-seam/cli.mjs`。CI 中请固定 `#<ref>`，不要跟随浮动分支。

> **环境要求**：Node.js **≥ 24.9**（`package.json` 的 `engines` 已声明）；TypeScript **已在 6.0.3 上验证**（引擎转译只使用稳定的 Compiler API，更旧的 5.x 预期可用但未逐一验证）。Level 2 接入对插件仓目录结构的要求：`package.json` 声明 `@deepseek-ai/*` 依赖、源码位于 `src/`、测试位于 `tests/`（`scan`/`verify` 按 `src`/`tests`/`scripts` 三个根目录扫描），且插件仓自身具备可运行的 TypeScript 编译与 `node --test` 测试管线来执行同步过去的机制测试。

### 3.1 三级接入对比与前置条件

| 接入级别 | 写入插件仓的文件 | 前置条件（逐级累加） | 覆盖能力与检查效果 |
| --- | --- | --- | --- |
| **Level 0：零配置检查** | 无（0 文件写入） | 已安装依赖（`node_modules` 含 `typescript` 与 `@deepseek-ai/*`） | 在内存中扫描源码并编译验证，当场检查当前安装的 DSH 版本下字段类型、非空约束与事件签名是否兼容 |
| **Level 1：提交契约文件** | 仅 `coupling.json` | + 提交 `package-lock.json`，CI 使用 `npm ci` | PR 中可审阅依赖变更；CI 自动拦截“改源码忘更 `coupling.json`”与“上游改动破坏显式类型契约” |
| **Level 2：完整契约测试套件** | `coupling.json` + `.dsh-seam.json` + 受管文件 + `tests/contracts/*` + `tests/seam-verify.test.ts` | + 至少一条调用宿主 API 的真实集成测试；若启用 `bump` 自动升级，还需 `@deepseek-ai/*` 使用精确版本号且 `engines.dsh` 上界设置为 `-0` 预发布上界（如 `>=0.2.2-rc.1 <0.3.0-0`） | 在 Level 1 基础上增加：隐含依赖（`as` 断言/无类型读取等）强制登记与运行时测试绑定、真实 `new Context()` 插件加载测试、人工覆盖规则（`overrides`）及上游依赖组升级闭环 |

---

### 3.2 Level 0：零配置直接检查（首次试用 / 本地快速排障）

无需修改插件仓库任何文件，在插件仓库根目录直接执行：

```sh
# 1. 在内存中扫描源码并针对当前 node_modules 验证全部类型契约
npx github:YMoose/dsh-seam#v0.1.0 verify --repo .

# 2. 查看完整的 Markdown 耦合报告与潜在隐含依赖列表
npx github:YMoose/dsh-seam#v0.1.0 scan --root .
```

---

### 3.3 Level 1：提交 `coupling.json` 契约门禁（轻量接入）

适合希望以最小改动获得编译期契约保护的插件仓库：

**步骤 1：生成并提交 `coupling.json`**

```sh
npx github:YMoose/dsh-seam#v0.1.0 scan --root . --write
git add coupling.json
```

**步骤 2：在 CI 中配置两条检查命令**

```sh
# 检查 1：防止修改了插件源码却忘记更新 coupling.json
npx github:YMoose/dsh-seam#v0.1.0 scan --root . --check

# 检查 2：验证 coupling.json 中的所有类型、字段读取与事件签名在当前依赖版本下编译通过
npx github:YMoose/dsh-seam#v0.1.0 verify --repo .
```

> **Level 1 下的隐含依赖处理**：`scan --check` 根据仓库中是否存在 `tests/contracts/implicit-seams.ts` 来判断是否启用隐含依赖强制门禁。Level 1 不创建该文件，扫描发现的潜在隐含依赖（`implicitSuspects`）会在终端列出供参考，不会报错阻断 CI（`exit 0`）。

---

### 3.4 Level 2：完整契约测试套件（受管文件同步 + 隐含依赖运行时测试）

适合核心生产插件，将类型契约编译、真实宿主 `Context` 加载、隐含依赖运行时验证与上游依赖升级全部纳入仓库测试体系。

#### 步骤 1：同步受管文件到插件仓库

```sh
# 在插件仓库根目录执行（写入受管脚本、引擎、机制测试与 .dsh-seam.json）
npx github:YMoose/dsh-seam#v0.1.0 sync
```

#### 步骤 2：创建隐含依赖登记表 `tests/contracts/implicit-seams.ts`

当 `node scripts/analyze-dsh-coupling.mjs --check` 报告存在未登记的隐含依赖（如 `as` 类型断言、读取无类型 `JsonValue`、协议正则等）时，在 `tests/contracts/implicit-seams.ts` 中登记确认（结构定义参考本仓 `payload/tests/contracts/implicit-seams.ts`）：

```ts
export interface ImplicitSeam {
  readonly id: string
  readonly description: string
  readonly usedAt: string
  readonly auditSection: string
  readonly probe: string
  /** 匹配 analyze-dsh-coupling 扫出的嫌疑位置（支持路径前缀、file:line 或 '/regex/'） */
  readonly acknowledged?: readonly string[]
}

export const IMPLICIT_SEAMS: readonly ImplicitSeam[] = [
  {
    id: 'session-custom-meta',
    description: '读取 Session.meta 中的扩展字段，需由集成测试验证运行时结构',
    usedAt: 'src/observer.ts:42',
    auditSection: '§1',
    probe: 'covering integration test',
    acknowledged: ['src/observer.ts:42'],
  },
]
```

#### 步骤 3：创建契约测试入口 `tests/seam-verify.test.ts`

在 `tests/seam-verify.test.ts` 中调用 `standardSpecs` 与 `runSeamSuite`，由插件仓原有的 `npm test`（`node --test`）统一执行：

```ts
import { findRepositoryRoot, loadCoupling, runSeamSuite } from './seam/engine.js'
import { standardSpecs } from './seam/standard-specs.js'
import { IMPLICIT_SEAMS } from './contracts/implicit-seams.js'

const ROOT = findRepositoryRoot()
const COUPLING = loadCoupling(ROOT)
// 第三个参数可传入本仓自定义的 SpecsLibrary（包含 unverifiable / implicitFragments / abnormal）
const SPECS = standardSpecs(COUPLING, IMPLICIT_SEAMS)

runSeamSuite({
  root: ROOT,
  coupling: COUPLING,
  fieldSpecs: SPECS.fieldSpecs,
  discriminantSpecs: SPECS.discriminantSpecs,
  unverifiable: SPECS.unverifiable,
  implicitFragments: SPECS.implicitFragments,
  implicitSeams: IMPLICIT_SEAMS,
  // 每个登记的隐含依赖需绑定运行时测试函数（implicitRuns）或指向现有的集成测试用例（implicitDelegations）
  implicitRuns: {},
  implicitDelegations: {
    'session-custom-meta': [
      { file: 'tests/integration/session.test.ts', tests: ['preserves custom session meta'] },
    ],
  },
  // 可选：当字段非空由被调辅助函数（如 requireAgent(exec.agent)）保证时，可通过 overrides 关闭该处的非空检查
  // overrides: {
  //   '@deepseek-ai/dsh-tools::agent@src/agent-opens.ts:137': {
  //     rootType: 'ToolRunContext',
  //     rootVar: 'exec',
  //     access: 'exec.agent',
  //     pin: false,
  //   },
  // },
})
```

#### 步骤 4：生成契约并接入日常 CI 与升级流程

```sh
# 1. 生成或更新 coupling.json
node scripts/analyze-dsh-coupling.mjs --write

# 2. CI 检查：受管文件完整性校验 + 契约与隐含依赖检查 + 运行包含 seam-verify 的测试套件
npx github:YMoose/dsh-seam#v0.1.0 check
node scripts/analyze-dsh-coupling.mjs --check
npm test
```

上游 `@deepseek-ai/dsh-*` 依赖升级流程：

1. **同步升级依赖组**：运行 `node scripts/bump-upstream.mjs` 统一对齐 `package.json` 中的 `@deepseek-ai/dsh-*` 版本号与 `engines.dsh`，并执行 `npm install --ignore-scripts`。
2. **先跑验证，后更基线**：运行 `node scripts/check-compat.mjs` 与全量 `npm test` 确认新版本契约与业务集成测试全部通过后，最后执行 `node scripts/write-baseline.mjs` 更新 `baseline.json` 哈希基线（切勿在验证通过前先重写基线）。
3. **升级 `dsh-seam` 工具链**：执行 `npx github:YMoose/dsh-seam#<new-tag> sync` 同步新版受管文件，按需运行 `node scripts/analyze-dsh-coupling.mjs --write` 更新契约，并同步更新 CI 中 `check` 命令的 `<new-tag>`。

---

## 4. 模块划分与功能架构

`dsh-seam` 由统一 CLI 入口（`cli.mjs`）驱动四个功能模块，支持直接运行命令与同步受管文件到仓库两种方式：

```text
                       ┌───────────────────────────────────────────┐
                       │              dsh-seam CLI                 │
                       │  仓库同步: sync / check                   │
                       │  直接运行: scan / verify / bump / compat /│
                       │            baseline                       │
                       └─────┬───────────────┬───────────────┬─────┘
                             │               │               │
        ┌────────────────────▼───┐   ┌───────▼───────────┐   ┌▼──────────────────────────┐
        │ 1. 契约扫描与隐含依赖  │   │ 2. 契约验证引擎   │   │ 3. 上游依赖升级与基线校验 │
        │ analyze-dsh-coupling   │   │ engine.ts         │   │ bump-upstream             │
        │                        ├──►│ standard-specs.ts │   │ check-compat              │
        │ 产物: coupling.json    │   │ verify-coupling   │   │ write-baseline            │
        │ 审计: implicitSuspects │   │ (类型编译+加载)   │   │ 产物: baseline.json       │
        └────────────────────────┘   └───────────────────┘   └───────────────────────────┘
```

### 模块一：契约扫描与隐含依赖检查（`scan`）
对应实现：`payload/scripts/analyze-dsh-coupling.mjs`

- **显式依赖提取**：基于 TypeScript AST 扫描 `src/` 与 `tests/`，生成结构化契约文件 `coupling.json`，文件头部携带溯源元数据（`schemaVersion`、`generator: { dshSeam, typescript }`、`generatedAt`，见 [design.md 决策 8](docs/design.md#4-关键架构决策记录)；`--write` 在契约内容未变时不重写文件），契约本体包含 7 类信息：
  1. `packages`：从 `@deepseek-ai/*` 导入的类型与值符号；
  2. `injectedServices`：声明注入或访问的 Cordis `Context` 服务；
  3. `srcHooks` / `testHooks`：`ctx.on()` / `ctx.emit()` 事件名称与回调参数形态；
  4. `fieldPaths`：上游类型上的属性访问链、前置类型收窄条件（`guards`）、循环遍历来源（`elementOf`）以及直接读取字段的非空约束（`pin: true`）；
  5. `discriminants`：联合类型判别字段与字面量的比较关系；
  6. `augmentations`：源码 `.ts` 中的 `declare module '@deepseek-ai/...'` 接口扩展；
  7. `borrowed`：在 `Context` 上访问、但类型定义来自其他插件而非当前源码显式导入的服务名。
- **潜在隐含依赖扫描（`implicitSuspects`）**：自动识别绕过静态类型检查的耦合写法（`as` 类型断言、`: string` 判别字段拓宽、无类型 `JsonValue` 字段读取、针对上游对象的 `WeakMap`、协议正则、`try` 块内断言等），在 Level 2 下对照 `tests/contracts/implicit-seams.ts` 检查是否已全部登记。

### 模块二：契约验证与测试套件引擎（`verify` & `runSeamSuite`）
对应实现：`payload/tests/seam/engine.ts`、`payload/tests/seam/standard-specs.ts`、`payload/scripts/verify-coupling.mjs`

提供两种运行方式，共用同一套类型检查代码生成与报错归因核心（`checkContract` + `SegmentDisposition`）：

- **独立 CLI 验证器（`verify` / `verify-coupling.mjs`）**：
  - 支持对插件仓库直接运行（若无 `coupling.json` 则在内存中即时扫描并验证），或直接传入一份及多份 `coupling.json` 在目标 `node_modules` 上脱离插件源码验证。
  - **当前脱离源码验证的范围**：插件源码 `.ts` 内的 `declare module` 接口扩展已保存在 `coupling.augmentations` 中，验证时会自动还原；插件仓库下的独立环境声明文件 `.d.ts` 目前仍从仓库目录读取，计划在 Phase 3 纳入 `coupling.json`（[design.md 原则 5](docs/design.md#原则-5契约文件couplingjson是可独立验证的跨仓快照)）。
- **仓库内完整测试套件（`runSeamSuite` + `standardSpecs`）**：
  - 在插件仓库的 `node --test` 中运行，除编译验证所有字段与判别条件外，还会创建真实 Cordis `new Context()` 实例验证插件加载、执行隐含依赖的运行时测试（`implicitRuns`）、检查委派的集成测试是否存在（`implicitDelegations`）、运行模拟上游删字段的反向测试（`abnormal`），并支持通过 `overrides` 对特定访问点做人工覆盖。

### 模块三：上游依赖同步升级与基线校验（`bump` / `compat` / `baseline`）
对应实现：`payload/scripts/bump-upstream.mjs`、`payload/scripts/check-compat.mjs`、`payload/scripts/write-baseline.mjs`

- **依赖组同版本升级（`bump`）**：查询 npm `next` 标签，将 `package.json` 中所有 `@deepseek-ai/dsh-*` 依赖统一对齐到目标版本，同步更新 `engines.dsh`（支持默认单版本模式与 `--keep-floor` 保留最低兼容版本模式），并结合 registry 发布时间与 `baseline.json` 的记录时间检测“版本号不变但重新发包”。
- **`engines.dsh` 兼容范围校验（`compat`）**：直接调用 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 官方接口，验证 `engines.dsh` 的最低版本准入与 `-0` 预发布版本上界拦截是否按预期生效。
- **已安装依赖哈希快照（`baseline`）**：提取 `node_modules/@deepseek-ai/*` 实际安装版本与 `integrity` 哈希写入 `baseline.json`，供 `bump --check` 与插件仓基线测试比对。

### 模块四：受管文件同步与完整性检查（`sync` / `check`）
对应实现：`cli.mjs`

- **受管文件同步（`sync`）**：将 `payload/` 下的共享脚本、引擎与机制测试复制到插件仓库，并在 `.dsh-seam.json` 中记录来源仓库地址（`source.repo`，归一化为 https 形式）、来源提交（`source.ref`）与每个受管文件的 `sha256` 哈希——清单完全可移植，不含任何本机绝对路径。若检测到目标文件存在未提交回上游的本地修改，`sync` 会拒绝覆盖以保护本地排障现场；再次 sync 时会提示上一次同步落后来源仓多少个提交。
- **受管文件完整性校验（`check`）**：**纯离线门禁**——只比对插件仓内受管文件与 `.dsh-seam.json` 记录的哈希，不定位 dsh-seam 源仓、不联网（[design.md 决策 7](docs/design.md#4-关键架构决策记录)）。外部 fork 的消费仓、无网 CI 均可直接运行；旧格式清单（含 `source.path`）兼容放行并提示重新 sync 补记溯源。
- **上游新版本提醒（`outdated`）**：联网（`git ls-remote`）提示上游默认分支 HEAD 与 semver 最新 tag 相对当前 pin 的状态。advisory 输出不具备阻断权力：网络不可达只提示跳过，永远退出 0；仅缺清单等用法错误允许非零退出。

---

## 5. 检查边界与职责划分

### 5.1 依赖来源五层划分（L0–L4）与分类处理规则

插件代码接触的上游类型按来源分为五层（`L0`–`L4`，见 [design.md 原则 7](docs/design.md#原则-7只对显式声明的依赖报错跨插件借用只识别不误报)）：
- **L1（源码显式导入）**：源码文件顶部的 `import ... from '@deepseek-ai/...'`；
- **L2a / L2b（本仓类型扩展）**：插件仓库内的独立环境声明文件 `.d.ts`（L2a），以及源码 `.ts` 中的 `declare module '@deepseek-ai/...'`（L2b）；
- **L3 / L4（跨插件服务借用）**：其他插件提供但当前文件未显式导入的声明合并（L3），以及跨插件动态注入的 `ctx.<service>` 服务（L4）；
- **L0（绕过静态类型检查的写法）**：在上游变量或判别字段上使用 `as` 类型断言、`: string` 字面量拓宽、`: any`、无类型 `JsonValue` 读取等。

`dsh-seam` 对这五层依赖按三类规则分别处理，做到既不漏报真实破坏、也不对动态插件借用误报（对应的代码实现约束见 [AGENTS.md §2](AGENTS.md#2-引擎实现不变量改代码不可破坏的红线)）：

| 依赖类别 | 声明来源 | `dsh-seam` 处理方式 | 检查结果 |
| --- | --- | --- | --- |
| **显式声明的依赖（L1 + L2a/L2b 锚定面）** | L1 源码显式 `import ... from '@deepseek-ai/...'`；L2a 仓库内 `.d.ts` 声明文件；L2b 源码 `.ts` 中的 `declare module '@deepseek-ai/...'` | 只加载 L1–L2 显式声明的类型，还原前置收窄条件与 L2b 扩展声明；对未加 `?.` / `!` / 空值判断的直接读取追加非空类型检查（`pin: true`），捕获“上游把非空字段改成可空” | 字段删改、签名不兼容、非空字段变可空 → **报错阻断 (`exit 1`)** |
| **跨插件注入的服务（L3 + L4 借用面）** | L3 其他插件包提供但当前文件未显式导入的声明合并；L4 跨插件动态注入的 `ctx.<service>` 服务 | 不从 `package.json` 强行加载源码未导入的包，而是根据编译器报出的属性缺失（`TS2339`）对照 `coupling.borrowed` 与 `injectedServices`，区分已声明 `inject`（`signed via inject`）与未声明借用（`unsigned`）；若原本属于 L1–L2 显式声明的字段在上游被删，则标记为 `[anchored -> borrowed]` | 正常跨插件服务借用 → 终端列出并放行 (`exit 0`)；显式声明的字段被上游移除（`[anchored -> borrowed]`）→ **报错阻断 (`exit 1`)** |
| **绕过类型检查的写法（L0 隐含依赖嫌疑）** | 上游变量或判别字段上的 `as` 类型断言、`: string` 字面量拓宽、`: any`、无类型 `JsonValue` 读取、上游对象 `WeakMap` 等 | 归入潜在隐含依赖（`implicitSuspects`），不生成强类型编译检查代码（避免触发连锁误报），交由 `scan --check` 检查 | Level 1 终端列出并放行（`exit 0`）；Level 2 要求在 `implicit-seams.ts` 登记并绑定运行时测试，未登记或登记表损坏 → **报错阻断 (`exit 1`)** |

### 5.2 适用范围与职责划分（工具链 vs 插件仓）

- **适用范围**：面向安装 `@deepseek-ai/cordis` 及 `@deepseek-ai/*` 类型包、通过 `ctx` 与声明合并接入宿主的 Cordis 进程内插件。外围独立 MCP Server、外部 CLI 或未安装 `@deepseek-ai/*` 的纯鸭子类型仓库不在服务范围内，`verify` 会自动以 `0/0 probes compile clean (skipped)` 正常退出（`exit 0`）。
- **与相邻工具的分工**：`dsh-seam` 站在插件作者侧做编译期检查（上游改了什么、坏在源码哪一行）；升级后插件能否正常加载的用户侧运行时检查，见社区项目 [dsh-plugin-health](https://github.com/EasonMWS/dsh-plugin-health)（在临时目录真装真启动插件，提供每日公开兼容表与 PR 兼容矩阵 Action）。两者的失败模式不重叠，可同时使用。
- **文件所有权划分**：

| 文件类别 | 具体文件 / 模块 | 所有权与职责边界 |
| --- | --- | --- |
| **受管共享文件** | `scripts/*.mjs`、`tests/seam/engine.ts`、`tests/seam/standard-specs.ts`、机制回归测试 `tests/*.test.ts` | 归属 `dsh-seam`：由 `sync` 单向复制到插件仓并由 `.dsh-seam.json` 锁定 SHA-256 哈希；不包含特定插件的业务规则 |
| **契约快照文件** | `coupling.json` | 归属插件仓（由 `scan --write` 生成）：记录插件对上游的真实调用面，随源码变更在 PR 中一起提交审阅 |
| **插件仓自定义规则与隐含依赖测试** | `tests/contracts/implicit-seams.ts`、`tests/contracts/seam-runs.ts`、`tests/seam/local-specs.ts`、`tests/seam-verify.test.ts` | 归属插件仓（Level 2）：登记 L0/运行时隐含依赖、配置无法静态验证的豁免项（`unverifiable`）与人工覆盖（`overrides`），并将隐含依赖绑定到插件自己的运行时测试 |
| **依赖哈希基线与兼容配置** | `baseline.json`、`package.json`（`engines.dsh`） | 协同维护：工具链记录已安装 `@deepseek-ai/*` 的 `integrity` 哈希并在 `bump --check` 中检测同版本重发；已记录哈希与实际安装包的逐项比对由插件仓自己的基线测试执行 |

- **长期核心模块 vs 阶段性辅助模块**（[design.md §1.2](docs/design.md#12-四项现实问题与模块演进重心)）：`scan` 与 `verify`（依赖提取与契约验证）是长期核心模块；`bump`、`baseline`、`compat` 是针对上游预发布阶段（尚无 SemVer 兼容承诺、`dist-tag` 不同步、同版本重新发包）的阶段性辅助模块，待上游发布流程规范化后即可按条件退场。

---

## 6. 本仓库开发与设计文档

- **设计思想与演进路线**：完整的问题背景分析、业界方案对比、15 项架构决策推导与演进路线图见 [docs/design.md](docs/design.md)。
- **开发契约与代码红线**：目录与单向同步边界、引擎代码级实现不变量及 TDD/同步工作流见 [AGENTS.md](AGENTS.md)。

本仓库日常自检命令（要求 Node.js ≥ 24.9）：

```sh
npm run typecheck   # 运行 TypeScript 类型检查
npm test            # 编译并运行全部机制回归测试（52 项）
npm run check       # 依次执行 typecheck 与 test
```
