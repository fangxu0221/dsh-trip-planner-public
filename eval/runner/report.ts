/** 逐条保存 Trace，再汇总 JSON/Markdown；基础设施错误不进入可评分样本的通过率。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelConfig } from './agent.ts'
import type { CaseResult } from './score.ts'
import type { Trace } from './trace.ts'

export const guidance: Record<string, string> = {
  wrong_tool: '检查该轮询问与工具选择，避免提前规划或用低层工具替代业务入口。',
  invalid_args: '核对交通方式、起终点和原始区县、排除词等要求。',
  state_lost: '使用当前 Session 的草稿及固定编号；继续时只传草稿引用。',
  duplicate_call: '复用上轮结果或已完成路段；确认是否应命中缓存。',
  hallucinated_fact: '只用结构化结果提供的事实，对缺少的字段明确说明。',
  budget_exceeded: '达到预算后保留进度并停止本轮查询。',
  upstream_error: '区分模型连接故障和场景预设的地图错误；检查对应事件。',
  timeout: '核对 Agent 运行时限与 Fake 工具的取消轨迹。',
  unexpected_result: '对照调用参数、业务结构化输出和预设响应。',
  unexpected_map_count: '检查派生调用、缓存与异常分支；结合根调用判断来源。',
  fixture_error: '补齐或修正本地模拟数据后再重跑。',
  missing_reply_signal: '检查自然语言回复是否提示该场景要求的关键信息。',
}
const pct = (part: number, total: number) => total === 0 ? null : Math.round(10000 * part / total) / 100
const tally = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(k => [k, values.filter(v => v === k).length]))
const merge = (rows: Record<string, number>[]) => {
  const result: Record<string, number> = {}
  for (const row of rows) for (const [k, v] of Object.entries(row)) result[k] = (result[k] ?? 0) + v
  return result
}
const cell = (text: string) => text.replace(/\|/gu, '\\|').replace(/[\n\r]/gu, ' ')
const label = (rate: number | null) => rate === null ? '—' : rate + '%'
const groups = ['A', 'B', 'C', 'D', 'E', 'F']

export async function createRunDirectory() {
  const dir = join(import.meta.dirname, '..', 'reports', new Date().toISOString().replace(/[:.]/gu, '-') + '-' + crypto.randomUUID().slice(0, 8))
  await mkdir(join(dir, 'traces'), { recursive: true })
  return dir
}

export async function writeTrace(dir: string, trace: Trace) {
  await writeFile(join(dir, 'traces', trace.id + '-r' + trace.attempt + '.json'), JSON.stringify(trace, null, 2) + '\n')
}

export async function writeReport(dir: string, cases: CaseResult[], run: {
  model: ModelConfig | null
  scenarioIds: string[]
  repeat: number
  startedAt: string
  durationMs: number
  stopped?: string
  source: Trace['source']
}) {
  const evaluated = cases.filter(c => c.status !== 'error').length
  const passed = cases.filter(c => c.status === 'pass').length
  const hardViolations = cases.flatMap(c => c.issues.filter(i => !['infrastructure', 'fixture', 'manual_review'].includes(i.source)))
  const allIssues = cases.flatMap(c => c.issues)
  const total = (field: 'cacheHits' | 'joinedRequests' | 'repeatedAgentTools' | 'repeatedMcp' | 'budgetRejected' | 'modelCalls') =>
    cases.reduce((sum, c) => sum + c.counts[field], 0)
  const category = Object.fromEntries(groups.map(group => {
    const rows = cases.filter(c => c.category === group)
    const success = rows.filter(c => c.status === 'pass').length
    const failure = rows.filter(c => c.status === 'fail').length
    return [group, { total: rows.length, passed: success, failed: failure, errors: rows.length - success - failure,
      successRate: pct(success, success + failure) }]
  }))
  const counts = {
    agentTools: merge(cases.map(c => c.counts.agentTools)), fakeMcp: merge(cases.map(c => c.counts.fakeMcp)),
    internalMcp: merge(cases.map(c => c.counts.internalMcp)), cacheHits: total('cacheHits'),
    joinedRequests: total('joinedRequests'), repeatedMcp: total('repeatedMcp'), repeatedAgentTools: total('repeatedAgentTools'),
    budgetRejected: total('budgetRejected'), modelCalls: total('modelCalls'),
    fakeOutcomes: merge(cases.map(c => c.counts.fakeOutcomes)), toolErrors: merge(cases.map(c => c.counts.toolErrors)),
  }
  const summary = { ...run, planned: run.scenarioIds.length * run.repeat, attempted: cases.length, evaluated, passed,
    failed: evaluated - passed, errors: cases.length - evaluated, successRate: pct(passed, evaluated),
    hardViolations: hardViolations.length, stateFailures: cases.filter(c => c.issues.some(i => i.metric === 'State Continuity')).length,
    manualReviewItems: cases.reduce((n, c) => n + c.manualReview.length, 0), category, counts,
    failuresBySource: tally(allIssues.map(i => i.source)), failuresByCode: tally(allIssues.map(i => i.code)),
  }
  const md = [
    '# Agent 场景评测 V1',
    '',
    run.source === 'real_agent' ? '真实 DeepSeek Agent + Fake 高德，未调用真实地图服务。' : '离线 Fixture 回放，仅验证评分与报告，不能用于推断模型能力。',
    '',
    '模型参数：' + (run.model ? JSON.stringify(run.model) + '；thinking=disabled；无模型重试。' : '无模型调用。'),
    '开始 ' + run.startedAt + '，耗时 ' + (run.durationMs / 1000).toFixed(1) + ' 秒。',
    '计划 ' + summary.planned + ' 次（' + run.scenarioIds.length + ' 题 × ' + run.repeat + '），尝试 ' + cases.length
      + ' 次；通过 ' + passed + '、失败 ' + summary.failed + '、不可评分 ' + summary.errors + '。',
    '可评分样本硬规则通过率：' + label(summary.successRate) + '；硬约束违反 ' + summary.hardViolations + '，状态失败场景 '
      + summary.stateFailures + '，人工复核项 ' + summary.manualReviewItems + '。',
    ...(run.stopped ? ['提前停止：' + run.stopped] : []),
    '',
    '| 类别 | 通过 | 失败 | 不可评分 | 通过率 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(category).map(([key, r]) => '| ' + key + ' | ' + r.passed + ' | ' + r.failed + ' | ' + r.errors + ' | ' + label(r.successRate) + ' |'),
    '',
    '模型请求 ' + counts.modelCalls + '；缓存命中 ' + counts.cacheHits + '；合并在途 ' + counts.joinedRequests
      + '；重复模型工具 ' + counts.repeatedAgentTools + '；重复实际地图 ' + counts.repeatedMcp + '；地图预算拒绝 ' + counts.budgetRejected + '。',
    '',
    '| 工具 | Agent 根调用 | 内部地图流水线 | 实际 Fake MCP |',
    '| --- | ---: | ---: | ---: |',
    ...[...new Set([...Object.keys(counts.agentTools), ...Object.keys(counts.internalMcp), ...Object.keys(counts.fakeMcp)])].sort()
      .map(k => '| ' + k + ' | ' + (counts.agentTools[k] ?? 0) + ' | ' + (counts.internalMcp[k] ?? 0) + ' | ' + (counts.fakeMcp[k] ?? 0) + ' |'),
    '',
    '| 场景 | 结果 | 归因与证据 | 排查建议 |',
    '| --- | --- | --- | --- |',
    ...cases.flatMap(c => c.issues.length ? c.issues.map(i => '| [' + c.id + ' r' + c.attempt + '](traces/' + c.id + '-r' + c.attempt
      + '.json) | ' + c.status + ' | ' + cell(i.source + '/' + i.code + '：' + (i.turn ? '第' + i.turn + '轮 ' : '') + i.evidence)
      + ' | ' + cell(guidance[i.code] ?? '检查该轮 Trace 和相应场景规则。') + ' |')
      : ['| [' + c.id + ' r' + c.attempt + '](traces/' + c.id + '-r' + c.attempt + '.json) | pass | 硬规则通过 | 语义仍按 cases.jsonl 中的人工项复核 |']),
    '',
  ].join('\n')
  await Promise.all([
    writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'),
    writeFile(join(dir, 'cases.jsonl'), cases.map(c => JSON.stringify(c)).join('\n') + '\n'),
    writeFile(join(dir, 'report.md'), md),
  ])
}
