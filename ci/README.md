# ci/ — 真实插件语料回归

对 `ci/plugins.json` 列出的真实第三方 DSH 插件仓做工具链回归：clone → 按锁文件安装依赖（一律 `--ignore-scripts`，第三方 install 脚本禁止执行）→ 逐仓跑六步探测闭环。

## 文件

| 文件 | 职责 |
| --- | --- |
| `plugins.json` | 语料列表。条目为 `{ repo, level, history? }`（字符串条目兼容、默认 level 0）；clone 失败视为列表失效、CI 判红，需要及时修剪 |
| `probe-loop.mjs` | 按级别探测（单一事实源，本地与 CI 共用）：L0 六步闭环 / L1 接入者只读断言 / L2 受管仓完整性门禁 |
| `probe-corpus.mjs` | 语料 runner：clone → install → 探测 → 汇总报告（`--report` 写文件供 artifact 上传） |
| `probe-history.mjs` | 历史适配回放（`--check`）：用插件仓版本迭代提交当 ground truth，断言工具的检测能力；`--discover`（离线填表）：在本地克隆上自动发现适配提交对并跑三点矩阵 |

## 历史适配回放（history 数组）

`plugins.json` 条目可带 `history` 数组，每项是**一个真实适配事件**的四字段断言
（英文键，另加可选 `expect` 与 `note`）：

```json
{ "repo": "https://github.com/…/dsh-foo", "level": 0,
  "history": [
    { "from": "<适配前 commit 全哈希>", "to": "<适配后 commit 全哈希>",
      "dshFrom": "0.1.7-rc.2", "dshTo": "0.2.1-rc.2",
      "expect": "detected", "note": "上游删 X 契约，被迫改用宿主 Y" }
  ] }
```

- **三点矩阵**：P=适配前提交，C=适配后提交，F(code,V)=该代码对版本 V 的失败
  表面集合。`NEW = F(P,dshTo) − F(P,dshFrom)`（工具检测到的升级新增破坏），
  `FIXED = NEW ∩ F(C,dshTo)`（其中适配后仍未修复的）。存量红脸天然被差集排除。
- **`expect: "detected"`**：断言 NEW≠∅ ∧ FIXED=∅——工具预言了作者真实遇到的
  破坏且作者的适配确实修好（战果）；**`expect: "routine"`**：断言 NEW=∅——
  例行升级未破坏锚定面，工具正确判兼容（未来若突然报 NEW≠∅ 即误报回归）。
  两类都是对工具行为的回归锚，偏离判红。
- **腐烂判红**：commit 哈希找不到（上游 rebase/force-push）或版本从 registry
  下架导致装配失败，与「列表失效」同语义——需要及时修剪。
- 入库战例先用 `--discover` 离线验证（只把跑过的对填进 JSON）：

```sh
node ci/probe-history.mjs --discover --only dsh-image-pathify   # 本地克隆填表
node ci/probe-history.mjs --check --only dsh-image-pathify      # 单仓断言
node ci/probe-history.mjs --check --report history-report.txt   # CI 全量（全量 clone）
```

CI（`real-plugin-probe` workflow 的 `history` job）与语料探测并行运行；需要全量
clone（探测 job 的 `--depth 1` 拿不到历史提交）。

## 级别语义（与工具链 Level 0/1/2 同构）

| level | 含义 | 断言 |
| --- | --- | --- |
| 0 | 零接入第三方仓 | 六步闭环：补戳元数据齐全 → 幂等 → 漂移门禁 → 戳记前后 verify 基线一致 → 复原零残留 |
| 1 | 已提交 `coupling.json` | 契约在案 + 戳记齐全 + `scan --check` 只读门禁绿（不写不复原）；verify 结果为观测 |
| 2 | 受管同步仓 | L1 全部 + `.dsh-seam.json` 在案 + `check --into` 离线完整性门禁绿 + `outdated` staleness 提示（note） |

声明级别与实际状态不符（如声明 L≥1 却无提交契约）计为 failure——配置诚实性检查。

## 运行

- GitHub Actions：`real-plugin-probe` workflow——每日定时（UTC 19:30 / 北京时间 03:30）+ 手动触发；报告上传 artifact
- 本地全量：`node ci/probe-corpus.mjs`（需网络；逐仓 clone + install，约 10–20 分钟）
- 本地小范围干跑：`node ci/probe-corpus.mjs --only agentero-dsh-plugin,dsh-ops`
- 本地对常驻克隆秒级回归：`node <dsh-plugins>/probe-dsh-seam.mjs`（本地薄包装，不进 Git）

> 定时跑的价值：第三方插件仓每天都在变（升级依赖、改源码、push 新仓），每日一轮能在
> 我们发布前发现工具链对真实生态的回归，也能积累生态观测数据（如 pin `typescript@^7`）。
> 注意 GitHub 会在仓库 60 天无活动后自动停用定时 workflow——快速迭代期不会遇到。

> **工具链依赖自愈**：runner 启动时若 dsh-seam 自身缺 `node_modules/typescript`，会自动 `npm ci`。这不是可选项——插件生态里已有 pin `typescript@^7`（Go 原生重写，无经典 Compiler API）与不含 typescript 的仓，payload 脚本一旦回退到插件仓的版本就会崩（首轮 CI 的真实教训）。

## 失败语义（与本地脚本一致）

第三方仓的红脸（探针失败、安装失败）是**观测记录**，不是 CI 失败；只有 dsh-seam 自身断言（schemaVersion/generator/generatedAt 齐全、幂等字节不变、漂移门禁绿、戳记前后 verify 基线一致、工作区零残留复原）或语料列表失效才判红。
