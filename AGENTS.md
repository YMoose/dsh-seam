# AGENTS.md — 开发实现契约与工程红线

本文面向在 `dsh-seam` 仓库中编写代码、修复缺陷或向消费仓同步脚本的开发者与 AI Agent。
文档分工：
- 功能架构与接入指南（面向插件用户）：见 [README.md](README.md)
- 设计思想、架构决策与演进路线（面向设计思考 / Why & Roadmap）：见 [docs/design.md](docs/design.md)
- 开发实现不变量与工作流规矩（面向代码实现 / How）：见本文

---

## 1. 仓库结构与单向同步边界

```text
dsh-seam/
├── cli.mjs                                  # 统一 CLI 入口（sync/check + 直接运行命令转发 + --recursive 编排）
├── payload/                                 # 受管同步目录（由 sync 单向复制到 Level 2 插件仓）
│   ├── scripts/
│   │   ├── analyze-dsh-coupling.mjs         # AST 依赖扫描与隐含依赖检查脚本（scan）
│   │   ├── verify-coupling.mjs              # 独立契约编译验证脚本（verify）
│   │   ├── bump-upstream.mjs                # @deepseek-ai/dsh-* 同版本同步升级与重发检测（bump）
│   │   ├── check-compat.mjs                 # 官方 evaluatePluginCompatibility 版本兼容范围校验（compat）
│   │   └── write-baseline.mjs               # node_modules 已安装包版本与哈希提取（baseline）
│   └── tests/
│       ├── seam/
│       │   ├── engine.ts                    # 类型检查代码生成、Compiler API 编译、SegmentDisposition 归因、Context 加载
│       │   └── standard-specs.ts            # 插件仓自定义规则合并工具
│       ├── mechanism/*.test.ts              # 自包含机制回归测试（同步至插件仓 tests/*.test.ts）
│       └── contracts/implicit-seams.ts      # 仅作本仓 tsc 类型检查夹具，严禁加入 MANAGED_FILES
└── docs/
    └── design.md                            # 设计思想、架构决策记录与演进路线
```

### 共享文件去业务化与单向同步红线（对应 [design.md 原则 2、决策 5/6](docs/design.md)）

1. **禁止安装上游业务包**：本仓库只依赖 `typescript`、`@types/node`、`@deepseek-ai/cordis`（要求 Node.js ≥ 24.9），严禁在 `package.json` 中引入任何 `@deepseek-ai/dsh-*` 业务包。
2. **禁止在 `payload/` 硬编码特定插件逻辑**：`payload/` 下所有脚本与引擎必须保持通用。严禁在 `payload/` 中写死特定插件的包名豁免、字段路径、行号或业务假设；插件仓特有的配置（`unverifiable`、`implicitFragments`、`abnormal`、`overrides`）一律由插件仓自己的非受管文件通过 `standardSpecs(coupling, implicitSeams, library)` 或 `runSeamSuite()` 参数传入。
3. **单向同步不可逆**：所有受管文件改动必须在 `dsh-seam/payload/` 完成并通过 `sync` 同步到插件仓；当 `sync` 检测到插件仓本地存在未提交回上游的修改时，必须拒绝覆盖并报错退出（`exit 1`）。
4. **本仓类型检查夹具隔离**：`payload/tests/contracts/implicit-seams.ts` 仅供本仓运行 `npm run typecheck` 时提供类型声明，绝不可加入 `cli.mjs` 的 `MANAGED_FILES`（否则会覆盖插件仓自己的隐含依赖登记表）。

---

## 2. 引擎实现不变量（改代码不可破坏的红线）

设计动机见 [README.md §1、§5](README.md#1-核心设计思想) 与 [design.md §3–§4](docs/design.md#3-核心设计原则)，以下为代码实现层的强制约束：

### 2.1 目标单位与 Workspace 向上查找（决策 15）

- **目标单位 = 插件包根目录**：`scan` 与 `verify` 的单次操作目标始终是单个插件包目录（`coupling.json` 归属该插件包），而非 monorepo 仓库根目录。
- **向上查找 `node_modules/@deepseek-ai`**：在 npm workspaces 等依赖提升布局下，子包目录自身没有 `node_modules`。所有查找已安装 `@deepseek-ai/*` 的代码必须调用 `dshNodeModulesBase(root)`（定义于 `payload/scripts/analyze-dsh-coupling.mjs`）或等价的向上查找逻辑（涵盖 `.d.ts` 入口解析、显式 `Context` 成员遍历、跨插件借用服务判定、以及 `verify-coupling.mjs` 判断是否安装了 `@deepseek-ai/*` 的检查逻辑），严禁只查 `join(REPO_ROOT, 'node_modules')`。
- **显式 `--recursive`**：多子包批量执行仅在 `cli.mjs` 收到 `--recursive` 参数时触发，且必须先打印候选子包发现表（包含匹配到的依赖数量或跳过原因）；未传 `--recursive` 且当前目录零耦合时，只打印候选子包引导提示，严禁静默代跑子包。

### 2.2 只编译显式声明类型与 L0–L4 分类处理（原则 7 / 决策 13）

- **禁止自动加载源码未导入的包**：生成的类型检查代码（探针）只允许引入插件显式声明的 L1–L2 类型（L1 源码显式 `import`、L2a 仓库内 `.d.ts` 声明文件、L2b 源码内 `declare module` 扩展）。严禁从 `package.json` 自动读取源码未显式导入的包加入探针头部。
- **通过 `TS2339` 识别跨插件服务借用**：`engine.ts` 中的 `checkContract` 根据只加载 L1–L2 类型时编译器报出的 `TS2339`（属性不存在），对照 `coupling.borrowed` 与 `injectedServices` 计算属性链逐段归因（`SegmentDisposition`）：
  - 正常跨插件服务借用（L3/L4）→ 区分已声明 `inject`（`signed via inject`）与未声明（`unsigned`），在终端列出并放行（`exit 0`）；
  - 原本属于 L1–L2 显式声明的字段在上游被移除 → 标记为 `[anchored -> borrowed]`，必须报错阻断（`exit 1`）。
- **L0 绕过类型检查的写法归入 `implicitSuspects`**：凡在上游变量或判别字段上出现 `as` 类型断言、`: string` 字面量拓宽、`: any`、无类型 `JsonValue` 读取，扫描器必须将其归入 `implicitSuspects`，不要为其生成强类型字段或判别检查代码（否则会触发 `TS2367` 或类型收窄为 `never` 的连锁误报）。

### 2.3 直接读取字段的非空检查实现细节（决策 14）

- **必须使用 `Exclude`，禁用 `NonNullable`**：对 `pin: true`（未加空值保护的直接字段读取），生成的类型检查代码必须使用 `type _Pin = Exclude<typeof _probe, null | undefined>` 来检查字段非空。**严禁改用 `NonNullable<typeof _probe>`**——在 TypeScript 中 `NonNullable<T> = T & {}`，当上游字段类型为 `unknown` 时会退化为 `{}`，导致合法的 `unknown` 字段读取误报 `TS2322`。
- **豁免条件**：源码中带有可选链 `?.`、非空断言 `!`、显式类型转换或前置空值判断时，`pin` 记为 `false`。
- **传给辅助函数的可空参数不在扫描器中静默豁免**：当源码把可能为空的字段直接传给内部自带空值检查的辅助函数（如 `requireAgent(exec.agent)`）时，单文件 AST 扫描无法确认被调函数的内部实现；此类情况统一由插件仓在 `runSeamSuite({ overrides })` 中显式设置 `pin: false`。

### 2.4 级别判断与透明输出（原则 4 / 原则 6）

- **禁止静默豁免**：不提供任何行内 `// dsh-seam-ignore` 注释机制；所有跨插件服务借用、已登记确认（`acknowledged`）的隐含依赖与默认过滤规则必须在终端逐条打印。
- **隐含依赖门禁开关规则**：`analyze-dsh-coupling.mjs --check` 根据是否存在 `tests/contracts/implicit-seams.ts` 区分接入级别：
  - 文件不存在（Level 1）：潜在隐含依赖在终端列出，但返回 `exit 0`；
  - 文件存在（Level 2）：存在未登记的隐含依赖时必须返回 `exit 1`；**若该文件存在但语法损坏或导出结构不可读，必须立即报错返回 `exit 1`**，严禁回退为空列表放行。
- **清理临时检查文件**：`engine.ts` 与 `verify-coupling.mjs` 编译时写入的任何临时文件必须在 `try ... finally` 中删除，不得残留污染工作区。

### 2.5 工具输出与写入范围红线（建议安全）

1. **`bump` 写入范围仅限两处**：`package.json` 中的 `@deepseek-ai/dsh-*` 依赖版本号与 `engines.dsh`。严禁改动 `scripts`、非 `dsh-*` 依赖、自定义字段或顶层键顺序。机制测试必须锁定该写入范围：fixture 携带 `scripts`、其他依赖与自定义字段，断言写入前后除两处允许变更点外逐项相等且键序不变（见 `payload/tests/mechanism/bump-upstream.test.ts` 的 write-scope 用例）。
2. **严禁输出“建议修改环境变量/宿主配置”类指引**：工具给出的操作建议若让用户改坏配置，杀伤力大于漏报。先例：相邻工具 dsh-plugin-health 的 doctor 告警建议设置 `NODE_USE_ENV_PROXY`，导致桌面应用在启动前崩溃（[EasonMWS/dsh-plugin-health#7](https://github.com/EasonMWS/dsh-plugin-health/issues/7)），该告警已整体移除。命令输出只允许描述工具自身改写后的后续操作（如重新 `npm install`），不允许建议用户修改其环境变量或宿主配置。

---

## 3. 开发、验证与同步工作流

### 3.1 修复缺陷：先写失败复现测试（原则 6-3）

修复扫描器（`analyze-dsh-coupling.mjs`）、验证引擎（`engine.ts`）或 CLI 的任何检测缺陷时，严格按两步执行：
1. 先在 `payload/tests/mechanism/` 对应测试文件中编写最小复现用例，运行测试确认能复现预期的失败结果；
2. 再修改实现代码使测试通过。严禁先改实现再补顺从实现的测试。

### 3.2 本仓库自检命令

一切结论以实际运行结果为准，不凭静态阅读判断：

```sh
npm run typecheck   # 运行 tsc --noEmit 类型检查
npm test            # 编译至 dist-test/ 并运行全部机制测试（node --test）
npm run check       # 依次执行 typecheck 与 test（提交前必跑）
```

> **机制测试中的 `cli.mjs` 存在性判断**：`payload/tests/mechanism/` 会同步到插件仓运行，而 `cli.mjs` 只存在于本仓库。凡在机制测试中直接调用 `../../../cli.mjs` 的用例，开头必须保留 `if (!existsSync(repoCli)) return` 判断，确保同步到插件仓后自动跳过而不报错。

### 3.3 同步消费仓与 Git 操作规范

1. **先 `git commit`，后 `sync`**：`node cli.mjs sync` 会将 `payload/` 工作区文件复制到目标插件仓，但 `.dsh-seam.json` 中的 `source.gitHead` 读取的是 `dsh-seam` 当前的 `HEAD` commit。因此修改 `payload/` 后，必须先在本仓完成 `git commit`，再执行 `node cli.mjs sync --into <consumerDir>`，否则插件仓记录的 commit 哈希会落后一拍。
2. **验证真实消费仓**：
   - Level 2 消费仓（`../obsystem/dsh-log-enhance`）：同步后在其目录运行 `npm test` 与 `node /path/to/dsh-seam/cli.mjs check`。
   - Level 1 / Workspace 消费仓（如 `dsh-editor-socket`）：运行 `scan --check` 与 `verify`（或 `--recursive`）确认检查全部通过。
   - 第三方插件仓实测：安装依赖一律加 `--ignore-scripts`（`npm install --ignore-scripts`）。
