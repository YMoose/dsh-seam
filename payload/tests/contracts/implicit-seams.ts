/**
 * SAMPLE / TYPECHECK FIXTURE ONLY — `dsh-seam sync` never writes this file
 * into consumers. Each consumer keeps its OWN `tests/contracts/implicit-
 * seams.ts` registry (its implicit seams are repo-specific by definition);
 * this copy exists so the payload's `import type { ImplicitSeam } from
 * '../contracts/implicit-seams.js'` (engine + standard-specs) typechecks
 * inside dsh-seam itself. The interface below is byte-stable with the
 * consumer-side definition — keep the two in sync when the shape evolves.
 */

export interface ImplicitSeam {
  /** 唯一标识，人工登记项和可执行检查都通过它关联。 */
  id: string
  /** 人类可读：这条隐含依赖是什么，上游变化后可能产生什么影响。 */
  description: string
  /** 代码位置（`文件:行号`），只是索引，不参与匹配。 */
  usedAt: string
  /** 对应的审计文档章节（章节命名与文档路径由各仓自定）。 */
  auditSection: string
  /** 验证方式；后续由可执行检查实现。 */
  probe: string
  /** 经人工确认的代码位置（语法见各仓自己的清单文件头）。 */
  acknowledged: string[]
  /** 已排除的本项目内部逻辑（附原因，语法同 `acknowledged`）。 */
  ignored?: string[]
}

export const IMPLICIT_SEAMS: ImplicitSeam[] = [
  {
    id: 'sample-version-lockstep',
    description: '样例：engines.dsh 下界、devDependencies 同版本依赖组和 baseline.json 指向同一验证基线。',
    usedAt: 'package.json:engines.dsh',
    auditSection: 'versioning.md §2',
    probe: 'assert engines.dsh floor === devDeps train === baseline train',
    acknowledged: ['package.json', 'baseline.json'],
  },
  {
    id: 'sample-with-ignored',
    description: '样例：带 ignored 排除项的形状，覆盖可选字段的类型面。',
    usedAt: 'src/sample.ts:1',
    auditSection: 'sample.md §1',
    probe: 'fixture probe',
    acknowledged: ['src/sample.ts:1'],
    ignored: ['src/sample.ts:2 — 本项目内部逻辑，不依赖上游的隐含行为'],
  },
]
