# ci/ — 真实插件语料回归

对 `ci/plugins.json` 列出的真实第三方 DSH 插件仓做工具链回归：clone → 按锁文件安装依赖（一律 `--ignore-scripts`，第三方 install 脚本禁止执行）→ 逐仓跑六步探测闭环。

## 文件

| 文件 | 职责 |
| --- | --- |
| `plugins.json` | 语料列表（git URL）。clone 失败视为列表失效、CI 判红，需要及时修剪 |
| `probe-loop.mjs` | 单仓六步探测循环（补戳 → 幂等 → 门禁 → 基线一致 → 复原），本地与 CI 共用的单一事实源 |
| `probe-corpus.mjs` | 语料 runner：clone → install → 探测 → 汇总报告（`--report` 写文件供 artifact 上传） |

## 运行

- GitHub Actions：`real-plugin-probe` workflow（手动触发）
- 本地全量：`node ci/probe-corpus.mjs`（需网络；逐仓 clone + install，约 10–20 分钟）
- 本地小范围干跑：`node ci/probe-corpus.mjs --only agentero-dsh-plugin,dsh-ops`
- 本地对常驻克隆秒级回归：`node <dsh-plugins>/probe-dsh-seam.mjs`（本地薄包装，不进 Git）

## 失败语义（与本地脚本一致）

第三方仓的红脸（探针失败、安装失败）是**观测记录**，不是 CI 失败；只有 dsh-seam 自身断言（schemaVersion/generator/generatedAt 齐全、幂等字节不变、漂移门禁绿、戳记前后 verify 基线一致、工作区零残留复原）或语料列表失效才判红。
