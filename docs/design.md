# Design — 设计思想、架构决策与演进路线

本文面向 `dsh-seam` 的维护者与希望深入了解架构思路的核心开发者，说明本工具链解决的问题本源、核心设计原则、已确定的架构决策及其原因，以及后续的演进路线。

---

## 1. 愿景与现实问题背景

### 1.1 愿景

`dsh-seam` 从服务单一插件（`dsh-log-enhance`）的兼容性检查脚本起步，目标是演进为所有 DSH 插件开发者都能低成本接入的契约测试工具链，并支撑多插件生态的自动化兼容性巡检：

- **对单插件开发者**：在上游迭代或插件发版前，第一时间知道“上游什么时候改坏了我、坏在哪个字段”；
- **对多插件维护者与社区生态**：无需逐个克隆和配齐各插件构建环境，即可批量验证多个插件在新版依赖下的兼容性与 API 使用分布。

### 1.2 四项现实问题与模块演进重心

DSH 生态存在四项客观现实，构成了本工具链各模块解决的具体问题。其中 ①～③ 是上游预发布阶段发布流程尚不规范带来的阶段性问题，④ 是动态插件架构本身决定的长期问题：

| 编号 | 现实问题 | 具体现象 | 对应模块 | 模块属性 |
| --- | --- | --- | --- | --- |
| **①** | **缺乏 SemVer 兼容承诺** | DSH 在 `next` 标签高频迭代，相邻 `rc` 之间可能直接改名、删字段或将非空字段改为可空，仅靠 `package.json` 版本号范围无法保证兼容。 | `scan` + `verify`、`compat` | `compat` 为阶段性；`scan`/`verify` 为长期 |
| **②** | **npm `dist-tag` 不同步** | `@deepseek-ai/dsh` 主包与 `@deepseek-ai/dsh-*` 子包必须保持同版本号配套，但子包 `latest` 标签有时滞后于 `next`，常规更新工具默认跟随 `latest` 会拼出版本不一致的依赖树。 | `bump` | 阶段性辅助模块 |
| **③** | **同版本号重新发包** | 曾发生版本号不变但包内容重新发布的情况，需结合 registry 发布时间（`time`）与压缩包哈希（`integrity`）识别。 | `baseline` + `bump --check` | 阶段性辅助模块 |
| **④** | **动态插件缺乏双向兼容检查** | 宿主尚无类似 VSCode 的 API 准入检查；插件通过 Cordis 动态服务注入、事件 hook 与 `declare module` 声明合并接入宿主，双方都缺乏破坏性变更感知。 | `scan` + `verify` + `coupling.json` | **长期核心模块** |

**演进重心与模块退场原则（问题消失时按序退场，不惯性维护）**：

1. **阶段性辅助模块（`bump` / `baseline` / `compat`）**：应对问题 ①～③，只修缺陷、不扩功能；一旦上游遵守 SemVer、修复 `latest` 标签同步、不再同版本重发，即退场交回给 Renovate / Dependabot 与常规 lockfile。
2. **长期核心模块（`scan` + `verify` + `coupling.json` + 隐含依赖检查）**：只要问题 ④ 仍在，提取插件真实调用面并做契约验证就始终具有长期价值。后续演进资源集中投入于此：降低外部插件接入门槛 → 契约格式标准化与跨仓收集 → 生态级批量兼容性验证。

---

## 2. 设计定位与业界方案对比

一句话定位：**在单进程 TypeScript 类型层与 Cordis 插件宿主层实现的消费方驱动契约测试（Consumer-Driven Contract Testing）**。

与相关业界方案的对比：

| 业界方案 | 借鉴的核心思想 | 我们的差异点 |
| --- | --- | --- |
| **Pact / 消费方驱动契约测试（CDC）** | 契约由调用方（插件）的真实使用定义，可脱离调用方源码独立验证目标版本兼容性 | 作用在进程内 TypeScript 类型层而非 HTTP 接口；契约从源码 AST 自动提取并生成类型检查代码，而非运行时录制 |
| **`@microsoft/api-extractor`** | 快照文件入库 + 发生未声明变更时在 CI 报错 | 视角相反：它记录提供方导出了什么，我们记录插件实际调用了什么 |
| **`tsd` / `dtslint`** | 修改类型声明删字段 → 检查代码必须编译失败的反向验证（`abnormal`） | 类型检查代码由 `coupling.json` 自动生成，无需手写类型断言 |
| **VSCode proposed API** | 宿主与插件之间的显式 API 边界治理 | 在缺乏官方 API 准入检查的阶段，从插件消费侧建立独立的兼容性防线 |
| **Rust `minimal-versions` / `cargo-semver-checks`** | `compat` 的上下界版本兼容性测试同属边界检查思路 | `semver-checks` 依赖提供方遵守 SemVer，DSH 当前不满足 |
| **Renovate / npm lockfile integrity** | 定时检测上游新版并锁定包内容哈希 | 额外增加 `@deepseek-ai/dsh-*` 依赖组同版本对齐与同版本号重发检测 |

---

## 3. 核心设计原则

### 原则 1：契约由插件的真实调用定义

`coupling.json` 记录插件源码实际读取的字段、注册的事件 hook、前置类型收窄条件以及直接读取字段的非空约束（`pin: true`），而不是手写一份上游 API 说明。前置收窄条件直接从插件源码 AST 自动提取，不维护容易过期的手写上游字典。

### 原则 2：引擎与共享文件不含特定插件的业务逻辑

`dsh-seam` 自身不安装任何 `@deepseek-ai/dsh-*` 业务包，不在引擎或同步目录（`payload/`）中硬编码特定插件的豁免清单与业务假设：
- 扫描器与验证引擎只负责通用 AST 提取与针对目标环境 `.d.ts` 的编译检查；
- 插件仓特有的配置（无法静态验证的豁免项 `unverifiable`、补充类型片段 `implicitFragments`、反向测试 `abnormal`、人工覆盖 `overrides`）一律由各插件仓自己的非受管文件传入。

### 原则 3：用 Git Tag 固定工具版本，不在插件仓引入 npm 依赖

通过 `npx github:YMoose/dsh-seam#<tag>` 按需直接运行或同步脚本，不进入插件仓 `package.json` 的 `devDependencies`。由此推导三条规则：
- **调用固定 `#<tag>`**：文档与 CI 示例一律固定具体版本，不拉取浮动 `HEAD`；
- **产物记录工具版本**：`coupling.json` 与 `.dsh-seam.json` 记录生成时的 `dsh-seam` 与 `typescript` 版本，排障时可区分“上游接口变更”与“工具自身升级”；
- **清单可移植**：`.dsh-seam.json` 目标形态只记录仓库地址、Git 版本和文件哈希，不绑定本机绝对路径。

### 原则 4：检查严格度与接入深度成正比（三级渐进接入）

按接入成本与保护范围划分为 Level 0（零配置内存检查）、Level 1（仅提交 `coupling.json` 检查显式类型契约）、Level 2（同步受管脚本 + 隐含依赖绑定运行时测试），接入指南见 [README.md §3](../README.md#3-渐进式接入指南level-0--1--2)。

**级别自动识别规则**：隐含依赖强制检查属于 Level 2，`scan --check` 以插件仓是否存在 `tests/contracts/implicit-seams.ts` 作为开关——文件不存在（Level 1）时，潜在隐含依赖仅在终端列出供参考、不报错阻断（`exit 0`）；文件存在但语法损坏或不可读时必须报错阻断（`exit 1`），绝不将损坏的登记表静默当成“已全部登记”。

### 原则 5：契约文件（`coupling.json`）是可独立验证的跨仓快照

不直接编译插件源码、而是先提取为 `coupling.json` 再生成检查代码，原因有三点：
1. **脱离插件源码异地快速验证**：多插件批量验证无需克隆并配齐数十个插件的构建环境，仅凭数 KB 的 `coupling.json` 即可在任意版本的上游 `.d.ts` 上生成等价的类型检查代码，并将报错定位回插件的 `file:line`。
2. **补齐插件自身的编译盲区**：验证引擎针对未加空值保护的直接读取专门生成非空类型检查，即使插件自身未跑 `tsc` 也能捕获“上游把非空字段改成可空”。
3. **PR 依赖变更可见**：任何新增的上游字段或事件依赖都会直接体现在 `coupling.json` 的 Git diff 中。

作为跨仓库共享文件的三项要求：包含版本元数据（`schemaVersion` + `generator`）、内容自包含（源码 `.ts` 内的 `declare module` 接口扩展已保存在契约中；仓库内独立 `.d.ts` 环境声明将在 Phase 3 纳入）、对外部契约输入做严格白名单校验。

### 原则 6：门禁只拦真问题、豁免全部透明、修缺陷先写复现测试

1. **区分“本地状态出错（CI 报错）”与“工具有新版本（仅提醒）”**：`check` / `verify` 只在插件仓自身状态不一致或上游破坏契约时报错；工具链发布新版本只通过独立的 `outdated` 命令提醒，绝不打断已接入仓库的正常 CI。
2. **不设静默豁免，字段变可空与人工确认都必须显式暴露**：
   - **直接读取字段的非空检查（`pin`）**：当上游将字段从非空改为可空（`string` → `string | undefined`）时，源码中未加 `?.` / `!` / 类型断言 / 空值判断的直接读取必须报 `TS2322` 编译错误；若空值安全由被调用的辅助函数内部保证，由插件仓通过 `overrides` 显式声明关闭该处的非空检查（类型检查代码的实现细节见 [AGENTS.md §2.3](../AGENTS.md#23-直接读取字段的非空检查实现细节决策-14)）。
   - **不设静默 `// ignore` 注释**：所有跨插件服务借用、人工登记确认（`acknowledged`）的隐含依赖与默认过滤规则，每次扫描均在终端逐条列出。
3. **修复工具自身的检测缺陷时，先写失败复现测试，再写修复代码**：防止迁就现有实现而把测试断言写宽（具体工作流见 [AGENTS.md §3](../AGENTS.md#3-开发验证与同步工作流)）。

### 原则 7：只对显式声明的依赖报错，跨插件借用只识别不误报

插件接触的类型按来源分为五层（详见 [README.md §5.1](../README.md#51-依赖来源五层划分l0l4与分类处理规则)）：**L1** 源码显式 `import`、**L2a/L2b** 本仓 `.d.ts` 与源码 `declare module` 扩展、**L3/L4** 跨插件声明合并与动态注入的 `ctx.<service>` 服务、**L0** 局部 `as` 断言与无类型读取。核心设计思路：
- **不自动混入未导入的包**：不从 `package.json` 强行加载源码未显式导入的包来拼凑全局类型环境——那样既脆弱，又会掩盖未声明 `inject` 的跨插件隐式耦合；
- **利用编译器的属性缺失报错识别跨插件借用**：生成的类型检查代码只在插件显式声明的 L1–L2 类型环境中编译，利用编译器产生的 `TS2339`（属性不存在）对照 `coupling.borrowed` 与 `injectedServices` 逐段归因（`SegmentDisposition`），同时实现“合法跨插件服务借用不误报”与“原本显式声明的字段被上游删除（`[anchored -> borrowed]`）精准报错”。

---

## 4. 关键架构决策记录

| # | 已确定的决策 | 原因与来源依据 | 状态 |
| - | --- | --- | --- |
| 1 | 前置类型收窄条件直接从插件源码 AST 自动提取 | 早期手写上游类型字典曾多次因上游迭代而过期；自动提取符合原则 1 | 已落地 |
| 2 | 引擎与共享脚本不含特定插件规则，插件特有配置由插件仓传入 | 保证 `payload/` 可无修改同步到任意插件仓（原则 2） | 已落地 |
| 3 | 默认跟随最新单版本，`--keep-floor` 保留最低兼容版本作为可选模式 | 不预先承担多版本矩阵成本；因契约编译足够轻量，需要时对多个历史版本 `.d.ts` 各跑一遍即可组成矩阵 | 已落地 |
| 4 | 独立工具仓 + Git Tag 固定版本 + 支持直接运行与同步受管文件两种方式 | 不污染插件仓 `package.json` 依赖与 lockfile（原则 3），同时兼顾零配置试用与深度接入 | 已落地 |
| 5 | 受管文件单向同步（`dsh-seam` → 插件仓）；`sync` 拒绝覆盖本地未提交改动 | 防止多仓脚本无意识分叉，同时保护插件仓本地临时排障现场 | 已落地 |
| 6 | 测试切分：工具机制测试随 `payload/` 同步，业务相关测试留在插件仓 | 共享文件不依赖具体插件业务；本仓 `payload/tests/contracts/` 仅作本仓类型检查夹具，不写入插件仓 | 已落地 |
| 7 | `check`（纯本地离线校验）与 `outdated`（联网新版本提醒）拆分；有阻断权力的检查只允许基于消费仓自身、离线且确定，一切涉及外部世界的状态只提示不阻断 | 工具发布了新版本不属于插件仓错误，不应让已接入仓库的 CI 报错（原则 6-1）；`check` 不依赖 dsh-seam 源仓存在，外部 fork 的消费仓与无网 CI 都能跑门禁 | 已落地 |
| 8 | 契约文件头部携带版本元数据：`schemaVersion` + `generator: { dshSeam, typescript }` + `generatedAt`；引擎遇到未知 schema 版本时拒绝执行并提示重新生成或升级，缺失（旧版文件）按当前语义继续 | 避免外部仓库提交无版本号的契约后带来长期兼容负担（原则 5）；`generatedAt` 与生成器溯源回应“这份数据是什么时候、哪版工具产的”的追溯需求（采纳自 dsh-plugin-health 作者的社区建议）；`--write` 幂等——契约内容未变时不重写文件，`generatedAt` 始终表示内容实际变化的时间 | 已落地 |
| 9 | 隐含依赖不绑定源码行号，改为用“确认 ID + 所在函数 + 表达式特征”匹配 | 行号随代码增删频繁偏移、维护成本高；同时拒绝静默 `// ignore` 注释（原则 6-2） | Phase 2.2 |
| 10 | 跨仓离线验证范围 = 类型契约编译检查 + 隐含依赖的声明汇总 | 隐含依赖的运行时验证依赖插件自身的业务测试代码，脱离插件仓库无法跨仓执行 | Phase 3 起 |
| 11 | `coupling.json` 随插件 npm 包一起发布，按约定 keyword 自动发现 | 无需自建中心化服务端，契约版本与发布的插件版本天然一致 | Phase 3 |
| 12 | 生态级批量巡检基于公开 npm 产物与本地 `--types-root` 路径映射运行 | 无需克隆各插件源码，即可针对任意目标版本的 `.d.ts` 批量验证多份 `coupling.json` | Phase 4 |
| 13 | 显式声明（L1–L2）编译报错 + 跨插件借用（L3–L4）分类识别 + 显式字段被删报错 + L0 类型断言归入隐含依赖检查 | 在多插件仓实测中，跨插件动态服务借用与局部 `as` 断言普遍存在；分层处理可同时避免漏报与误报（原则 7） | 已落地 |
| 14 | 未加空值保护的直接读取记录 `pin: true` 并用 `Exclude<…, null \| undefined>` 检查非空；含 `?.`/`!`/类型断言/空值判断时豁免 | 普通赋值无法检测字段从非空变为可空；而 `NonNullable<unknown>` 会退化为 `{}` 导致误报，改用 `Exclude` 保持精确检查（原则 6-2） | 已落地 |
| 15 | 扫描与验证的目标单位 = 插件包根目录；workspace 依赖提升布局自动向上查找最近的 `node_modules/@deepseek-ai`；多插件包 monorepo 通过显式 `--recursive` 逐包执行 | 契约以单个插件包为单位发布与标识（决策 11 前提）；显式 `--recursive` 避免静默递归，符合原则 6-2 与主流包管理器习惯 | 已落地 |
| 16 | dist-tag 仅用于“跟随”（`bump` 选取升级目标）；一切兼容性判断、统计与版本发现一律以具体版本号做 semver 比较，不按 tag 名判断；tag 指向的版本不比 `latest` 新时丢弃并记录原因 | 相邻工具 dsh-plugin-health 曾按 tag 名选兼容表版本列：`alpha` 一度指向比 `latest` 旧五天的版本，135 个插件被误判“被拒”，其修复改为 semver 比较 + 丢弃过期 tag 并记录原因；本项目 `verify` 已锚定实际安装版本、`bump` 降级守卫按 semver 比较，本决策将现状固化为明文规则，并约束 Phase 4 巡检的版本发现 | 已落地（规则固化） |
| 17 | typescript 解析守卫：只接受带经典 Compiler API 的 JS 版 typescript（5.x/6.x）；锚点链中途遇到无经典 API 的包（原生 7.x 仅版本存根）则跳过继续向后尝试，全部锚点均不可用时显式报错退出并点名解析到的版本与路径 | typescript@7 npm 包（Go 原生实现）根导出仅 4 行版本存根（`lib/version.cjs`），无 `ts.SyntaxKind`/`createProgram`；插件生态已出现 pin `^7.0.2` 的仓（语料 CI 首轮事故：dsh-context/dsh-market/dsh-wallpaper-engine 以 `Cannot read properties of undefined` 天书崩溃）；Level 2 消费仓的 payload 解析锚点优先命中本仓 node_modules，接入者升级原生版当天即踩雷；`verify` 侧守卫先于 engine 候选加载，同时覆盖 engine 直导与转译两条路径 | 已落地 |
| 18 | 多版本验证的类型重定向用「混合符号链接树」而非 `paths`：探针写入临时目录，其 `node_modules/@deepseek-ai/` 下 DSH 系列包逐个链接到 `--types-root`，其余 `@deepseek-ai/*`（cordis 等）链接到本仓安装，配 `preserveSymlinks` 编译 | 实测 `compilerOptions.paths`（含绝对路径与 baseUrl 两种写法）在 NodeNext 下不生效（TS2307）；且 DSH 包对 cordis 的 `declare module '@deepseek-ai/cordis'` 事件增强（hook 探针的 `keyof Events` 依赖它）要求增强方与被增强方同处一棵解析树，否则增强静默丢失、hook 探针全红——单链接整目录方案在 dsh-log-enhance 真实集成验证中暴露此缺陷；混合树让“DSH 系列换版本、独立包用本地”落在自然解析语义上 | 已落地 |

---

## 5. 已知工程边界与命名由来

- **隐含依赖的运行时测试只能在插件仓内执行**：脱离插件仓做批量验证时只能汇总其声明信息，无法跨仓运行插件私有测试代码（决策 10）。
- **TypeScript 版本差异**：扫描器与 `verify` 使用插件仓安装的 `typescript`，且要求其为带经典 Compiler API 的 JS 版（5.x/6.x）——原生 7.x（Go 实现）根导出只有版本存根，解析到时显式报错点名版本与路径（决策 17）；不同 TS 版本的 AST 结构与报错信息可能存在细微差异，需在契约中记录实际使用的 TS 版本（原则 3）。
- **插件仓运行环境要求**：Level 2 受管测试在插件仓自己的 `tsconfig`、`node:test`、`tests/` 目录下运行，要求 Node.js ≥ 24.9。
- **上游刚发版时的短暂时间差**：在 npm 新版本刚发布的分钟级窗口内可能出现探测时间差，靠定时任务重跑自动恢复；后续将统一以 registry 的 `dist.integrity` 哈希作为比对依据。
- **CI 配置文件不纳入 `sync` 受管范围**：各插件仓的 `.github/workflows` 自主维护，后续外部接入增多后可提供可复用的 GitHub Actions 模板。
- **命名由来**：`seam`（接触面/接缝）借自 Michael Feathers《Working Effectively with Legacy Code》——指代模块之间不修改源码就能观测和检验交互行为的边界。

---

## 6. 演进路线图（Roadmap）

```text
Phase 1            Phase 2              Phase 3              Phase 4
引擎通用化   ──►   外部插件接入   ──►   契约标准化与收集 ──►  多插件兼容性自动巡检
(已完成)           入口条件 + 降摩擦     schema + 校验 + 发现   批量契约验证与统计
```

阶段依赖：Phase 2 的基础条件（2.0）在向更多外部插件推广前完成；Phase 3 为跨仓收集提供统一的契约格式与白名单校验；Phase 4 基于收集到的契约对上游新版本执行自动化批量验证。

### Phase 1：引擎通用化与核心机制闭环（已完成）

- **消除单仓库特定假设**：前置收窄条件与 `for...of` 循环根变量归一化、支持任意参数名的 `: Context` 宿主入口识别、多参数事件 hook 与同名不同签名 hook 去重、多行接口扩展（`declare module`）还原。
- **L0–L4 分类检查与逐段报错归因**：L2b 源码内 `declare module` 保存与还原、`coupling.borrowed` 已声明/未声明跨插件服务借用识别、`[anchored -> borrowed]` 显式字段被删报错、引擎统一计算属性链逐段归因（`SegmentDisposition`）、L0 类型断言与拓宽归入 `implicitSuspects`、Level 1/2 按登记表是否存在自动切换检查行为。
- **直接读取字段的非空检查（原则 6-2）**：扫描器记录 `pin: true`（含 `?.`/`!`/类型断言/空值判断时豁免），生成 `Exclude<typeof _probe, null | undefined>` 类型检查，捕获上游将非空字段改为可空。
- **共享文件去业务化与自包含测试**：`standard-specs.ts` 剥离特定插件规则改为参数传入，新增 `seam-suite.test.ts` 端到端测试；已在 `dsh-log-enhance`（Level 2）、`dsh-editor-socket`（Level 1）及多个真实 DSH 插件仓（Level 0）验证通过。

### Phase 2：外部插件低成本接入（当前推进）

- **2.0 基础条件**：
  - **正式版本 Tag 与可移植清单（原则 3，已落地）**：已发布首个正式 tag（`v0.1.0`）；`.dsh-seam.json` 只记录 `source.repo`（归一化 https 仓库地址）+ `source.ref`（来源 commit）+ 文件哈希，不含本机绝对路径；`gitHead()` 在无法获取 commit 或仓库地址时显式报错拒绝 sync（绝不写入 `unknown` 占位）。
  - **本地校验与新版本提醒拆分（决策 7，已落地）**：`check` 为纯离线门禁，只比对受管文件哈希，不定位 dsh-seam 源仓、不联网；`outdated` 联网（`git ls-remote`）提示上游 HEAD 与 semver 最新 tag（决策 16：tag 先解析成版本号再比较），永不阻断退出；上一次 sync 落后来源仓多少由 `sync` 提示。
  - **契约版本元数据（决策 8，已落地）**：`coupling.json` 头部携带 `schemaVersion`、`generator: { dshSeam, typescript }` 与 `generatedAt`；引擎遇到未知 schema 版本时拒绝执行；`--write` 幂等（契约未变不重写）。
  - **环境要求声明（已落地）**：README §3 明确 Node.js ≥ 24.9（`package.json` `engines` 同步声明）、TypeScript 已验证版本（6.0.3）与 Level 2 对插件仓目录结构（`src`/`tests`/`scripts` 约定与测试管线）的要求。
- **2.1 同步文件分档（`--profile core | full`）**：`core` 仅同步引擎、规格合并工具、`scan`/`verify` 及其机制测试；`full` 额外包含 `bump`/`baseline`/`compat`。无 profile 字段的已有清单默认按 `full` 处理。
- **2.2 隐含依赖不绑定源码行号（决策 9）**：支持用 **确认 ID + 所在函数名 + AST 表达式特征** 匹配已登记的隐含依赖，避免增删代码导致行号偏移；所有已登记条目仍在终端具名列出。
- **2.3 TypeChecker 辅助类型解析**：在保留纯 AST 快速扫描的基础上，对未显式标注类型的局部变量提供基于 `ts.Program` / `TypeChecker` 的可选类型推导并写入 `coupling.json`，减少手写 `overrides`。
- **2.4 workspace 多插件包递归检查（`--recursive`，已落地）**：自动向上查找 `node_modules/@deepseek-ai` 兼容 workspace 依赖提升布局；workspace 声明同时读取 `package.json` 的 `workspaces` 与 `pnpm-workspace.yaml` 的 `packages:`（pnpm 在插件生态常见，且 pnpm 仓常以 `packages: ['.']` 声明根单包）；`scan --recursive` 与 `verify --recursive` 显式发现子包、打印发现表并汇总退出码。
- **2.5 单插件多版本验证（`--types-root` / `--upstream`，已落地）**：`--types-root <dir>` 将验证锚点从向上查找的 `node_modules` 改为显式指定的类型目录（决策 12 机制的提前落地，可完全离线测试），目录形态与 `node_modules` 同构（其下有 `@deepseek-ai/<pkg>/…`），报告行标注实际被测版本；`--upstream <版本号|tag>` 对 coupling 引用的全部 DSH 系列包（含深导入子路径键，先归一化到根包名）从 registry 按同一版本 lockstep 拉取（`npm pack` 走 npm 自身配置，尊重 registry 镜像与代理），解出包摆成临时 `--types-root` 后验证，进程退出时清理；**已退出 lockstep 的包**（目标版本未发布——真实语料：`dsh-client-runtime` 停更于 0.1.1-rc.2 而其余包升 0.2.x，dsh-image-pathify 的 `client.inject` 声明引用它导致整组 notarget）逐包回落到其最新已发布版本并打印明示，一个版本都没发过的包仍显式报错。类型重定向机制见决策 18（混合符号链接树 + `preserveSymlinks`——`paths` 在 NodeNext 下实测不生效，且声明合并要求同树）；`cordis` 等独立版本包沿用本地已安装类型；tag 输入先解析为具体版本号再参与判断（决策 16）。用于作者在升级前评估“升到目标版本会坏哪里”，不必先改 `package.json` 重装依赖。真实验证：dsh-log-enhance 于 0.1.0-rc.6～0.2.2-rc.3 四个版本上验证（0.1.0-rc.6 抓到判别字面量漂移 TS2367）；dsh-context（Level 0 ephemeral）对 `next` tag 验证结果与本地安装基线逐项一致。
- **2.5b 历史适配回放（`ci/probe-history.mjs`，已落地）**：用真实插件仓的版本迭代提交当 ground truth 校验检测能力——`plugins.json` 条目可带 `history` 数组（`{from, to, dshFrom, dshTo, expect, note}`），断言语义为失败表面集合的三点矩阵：`NEW = F(适配前提交, dshTo) − F(适配前提交, dshFrom)`（工具能否检测到作者当时面对的破坏）、`FIXED = NEW ∩ F(适配后提交, dshTo)`（作者的适配是否真的修好），存量红脸天然被差集排除；`expect: "detected"`（战果：NEW≠∅ ∧ FIXED=∅）与 `expect: "routine"`（正确判兼容：NEW=∅）两类都是工具行为回归锚，偏离/commit 腐烂/registry 缺版判红。适配提交对由 `--discover` 在本地克隆上机械发现（锁文件 DSH 系列版本集变化 + lockstep 校验；`dsh-client-runtime` 这类停更包自动回落最新已发布版），验证过的对才入库；CI 与语料探测并行独立 job（全量 clone）。首轮全量回放（13 仓）的生态观测：仅 2 仓存在可回放适配对（共 4 对，含 0.1→0.2 大版本跨越），**全部 routine**——0.x 阶段 DSH 上游对插件类型锚定面以增量演进为主、破坏性变更稀少，作者适配提交多为声明/文档层例行跟随；其余 11 仓版本集无 first-parent 变化或为 squash 开源根提交（无适配前历史）。detected 战例在当前语料中尚未出现，机制待未来真实破坏事件补齐第一例。
- **2.6 原生 typescript（7.x Go 实现）兼容观测（远期，只记录不动手）**：生态观测——语料中已有插件仓 pin `typescript ^7.0.2`；其 npm 包根导出仅为版本存根，程序化 API 全部位于 `typescript/unstable/*` 子路径（`unstable/sync`、`unstable/ast/*`），官方明确标注不稳定、可能变更。当前策略已由决策 17 固化：工具链只消费经典 Compiler API，遇到原生版显式报错。是否为 engine 增加 `unstable/*` 原生 API 后端，等两个信号之一再评估：微软将 API 摘掉 `unstable` 标注，或 DSH 官方插件生态整体转向原生版；届时结合每日语料 CI 的观测数据决策。

### Phase 3：契约标准化与收集

1. **完整自包含与插件身份元数据**：将插件仓内独立 `.d.ts` 环境声明（L2a）纳入 `coupling.json`；扩充插件身份信息（`plugin: { name, version, dshRange }`）与隐含依赖声明摘要（`implicitSeams`，仅含 id、类别、位置与说明，不含测试代码）。
2. **外部契约白名单校验（原则 5）**：对第三方契约中的包名、标识符、类型名做严格正则校验，防止异常输入进入类型检查代码生成。
3. **契约随 npm 包发布与自动收集（决策 11）**：约定 `package.json` 的 `"dshSeam"` 字段与 keyword，新增 `dsh-seam collect` 从 npm registry 批量拉取社区插件契约。

### Phase 4：多插件兼容性自动巡检

- **针对上游新版本的批量契约验证（`dsh-seam ecosystem-verify`）**：每当检测到上游 `@deepseek-ai/*` 发布新的 `next` 版本（或通过 `--types-root` 指定本地类型目录），自动用收集到的多份插件契约跑一遍验证，定位破坏性变更并生成兼容性报告；版本发现按具体版本号 semver 排序与角色标注执行，不按 tag 名判断（决策 16）。
- **生态 API 使用统计**：汇总各插件对上游字段与事件 hook 的使用频次、常见的隐含依赖以及跨插件服务依赖关系。

### 阶段完成标准

| 阶段 | 完成标准 |
| --- | --- |
| **Phase 1（已完成）** | 本仓源码与机制测试不依赖特定业务插件仓；L0–L4 分类检查、直接读取非空检查与套件端到端测试闭环；在试点仓与真实插件仓验证通过 |
| **Phase 2** | 2.0 基础条件全部落地并发布首个正式 tag；`dsh-seam` 常规提交不导致已接入插件仓的 CI 报错；除 `dsh-log-enhance` 外至少 2 个独立插件通过 Level 0/1 接入 |
| **Phase 3** | L2a 声明自包含与白名单 schema 校验落地并能拦截非法输入；至少 1 个插件的 npm 包携带 `coupling.json` 并能被 `collect` 自动收集 |
| **Phase 4** | 对每次新发布的上游 `next` 版本自动产出多插件兼容报告；以一组插件契约为输入可在数秒内输出兼容性影响与 API 调用统计清单 |
