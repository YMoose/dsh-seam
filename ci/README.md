# ci/ — 真实插件语料回归

对 `ci/plugins.json` 列出的真实第三方 DSH 插件仓做工具链回归：clone → 按锁文件安装依赖（一律 `--ignore-scripts`，第三方 install 脚本禁止执行）→ 逐仓跑六步探测闭环。

## 文件

| 文件 | 职责 |
| --- | --- |
| `plugins.json` | 语料列表。条目为 `{ repo, level }`（字符串条目兼容、默认 level 0）；clone 失败视为列表失效、CI 判红，需要及时修剪 |
| `probe-loop.mjs` | 按级别探测（单一事实源，本地与 CI 共用）：L0 六步闭环 / L1 接入者只读断言 / L2 受管仓完整性门禁 |
| `probe-corpus.mjs` | 语料 runner：clone → install → 探测 → 汇总报告（`--report` 写文件供 artifact 上传） |

## 级别语义（与工具链 Level 0/1/2 同构）

| level | 含义 | 断言 |
| --- | --- | --- |
| 0 | 零接入第三方仓 | 六步闭环：补戳元数据齐全 → 幂等 → 漂移门禁 → 戳记前后 verify 基线一致 → 复原零残留 |
| 1 | 已提交 `coupling.json` | 契约在案 + 戳记齐全 + `scan --check` 只读门禁绿（不写不复原）；verify 结果为观测 |
| 2 | 受管同步仓 | L1 全部 + `.dsh-seam.json` 在案 + `check --into` 离线完整性门禁绿 + `outdated` staleness 提示（note） |

声明级别与实际状态不符（如声明 L≥1 却无提交契约）计为 failure——配置诚实性检查。

## 运行

- GitHub Actions：`real-plugin-probe` workflow（手动触发）
- 本地全量：`node ci/probe-corpus.mjs`（需网络；逐仓 clone + install，约 10–20 分钟）
- 本地小范围干跑：`node ci/probe-corpus.mjs --only agentero-dsh-plugin,dsh-ops`
- 本地对常驻克隆秒级回归：`node <dsh-plugins>/probe-dsh-seam.mjs`（本地薄包装，不进 Git）

> **工具链依赖自愈**：runner 启动时若 dsh-seam 自身缺 `node_modules/typescript`，会自动 `npm ci`。这不是可选项——插件生态里已有 pin `typescript@^7`（Go 原生重写，无经典 Compiler API）与不含 typescript 的仓，payload 脚本一旦回退到插件仓的版本就会崩（首轮 CI 的真实教训）。

## 失败语义（与本地脚本一致）

第三方仓的红脸（探针失败、安装失败）是**观测记录**，不是 CI 失败；只有 dsh-seam 自身断言（schemaVersion/generator/generatedAt 齐全、幂等字节不变、漂移门禁绿、戳记前后 verify 基线一致、工作区零残留复原）或语料列表失效才判红。
