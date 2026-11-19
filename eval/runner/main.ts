/** 显式选择运行范围；首例没有可用模型响应时停止，避免用失败连接跑完整批次。 */
import { parseArgs } from 'node:util'
import { defaultModel, modelConnection, runAgent, type ModelConfig } from './agent.ts'
import { loadScenarios } from './scenarios.ts'
import { createRunDirectory, writeReport, writeTrace } from './report.ts'
import { score, type CaseResult } from './score.ts'

const help = 'pnpm.cmd --dir eval run agent -- --list | --smoke | --id AGENT-005 | --tag transit | --all [--repeat 3]\n'
function integer(v: string, name: string, min: number, max: number): number {
  const n = Number(v)
  if (!/^\d+$/u.test(v) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(name + ' 需要 ' + min + '–' + max + ' 的整数')
  return n
}
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((value, i) => i !== 0 || value !== '--'),
    options: {
      help: { type: 'boolean' }, list: { type: 'boolean' }, smoke: { type: 'boolean' }, all: { type: 'boolean' },
      id: { type: 'string', multiple: true }, tag: { type: 'string' }, repeat: { type: 'string', default: '1' },
      model: { type: 'string', default: process.env.DSH_EVAL_MODEL || defaultModel },
      temperature: { type: 'string', default: '0' }, 'max-tokens': { type: 'string', default: '1200' },
      'max-model-calls': { type: 'string', default: '12' }, 'max-tool-calls': { type: 'string', default: '18' },
      'timeout-ms': { type: 'string', default: '90000' }, 'run-timeout-ms': { type: 'string', default: '1800000' },
    }, strict: true,
  })
  if (values.help) { process.stdout.write(help); return }
  const scenes = loadScenarios()
  if (values.list) { for (const s of scenes) console.log(s.id, s.category, s.description); return }
  if ([values.smoke, values.all, values.id, values.tag].filter(Boolean).length !== 1)
    throw new Error('请选择一个运行范围。\n' + help)
  if (values.id?.some(id => !scenes.some(s => s.id === id))) throw new Error('存在未知场景 ID，先使用 --list')
  const selected = scenes.filter(s => values.all || (values.smoke ? s.tags.includes('smoke')
    : values.id ? values.id.includes(s.id) : s.tags.includes(values.tag!)))
  if (!selected.length) throw new Error('没有匹配场景')
  const repeat = integer(values.repeat, 'repeat', 1, 20)
  if (values.smoke && (repeat !== 1 || selected.length < 2 || selected.length > 3))
    throw new Error('首次 Smoke 固定 2–3 题，各运行一次')
  const temperature = values.temperature === 'default' ? undefined : Number(values.temperature)
  if (temperature !== undefined && (!values.temperature.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > 1))
    throw new Error('temperature 必须在 0–1，或为 default')
  if (!/^[A-Za-z0-9_.:/-]{1,100}$/u.test(values.model) || /^sk-/iu.test(values.model)) throw new Error('模型 ID 格式不合法')
  const options: ModelConfig = {
    model: values.model, temperature, maxTokens: integer(values['max-tokens'], 'max-tokens', 32, 8192),
    maxModelCalls: integer(values['max-model-calls'], 'max-model-calls', 1, 50),
    maxToolCalls: integer(values['max-tool-calls'], 'max-tool-calls', 1, 100),
    timeoutMs: integer(values['timeout-ms'], 'timeout-ms', 1000, 600000),
  }
  const runTimeoutMs = integer(values['run-timeout-ms'], 'run-timeout-ms', 1000, 7200000)
  let connection: ReturnType<typeof modelConnection>
  try { connection = modelConnection(options) } catch { throw new Error('模型配置不可用：检查 DEEPSEEK_API_KEY 和 HTTPS Messages 协议 DEEPSEEK_BASE_URL。') }
  const dir = await createRunDirectory()
  console.log('真实模型：' + options.model + '；报告：' + dir)
  const startedAt = new Date().toISOString()
  const start = performance.now()
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const timer = setTimeout(cancel, runTimeoutMs)
  process.once('SIGINT', cancel)
  const cases: CaseResult[] = []
  const run = { model: options, scenarioIds: selected.map(s => s.id), repeat, startedAt, durationMs: 0,
    source: 'real_agent' as const, stopped: undefined as string | undefined }

  try {
    outer: for (let attempt = 1; attempt <= repeat; attempt++) for (const scene of selected) {
      if (controller.signal.aborted) { run.stopped = '整次运行达到时限或收到中断请求'; break outer }
      const trace = await runAgent(scene, attempt, options, connection, controller.signal)
      const result = score(scene, trace)
      await writeTrace(dir, trace)
      cases.push(result)
      console.log(scene.id + ' r' + attempt + ' ' + result.status.toUpperCase() + ' (' + trace.durationMs + 'ms)')
      if (result.status === 'error' && (trace.model.some(m => m.error) || !trace.model.some(m => m.completed))) {
        run.stopped = '模型或适配器请求未完成，已停止后续付费请求'
        break outer
      }
    }
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', cancel)
    run.durationMs = Math.round(performance.now() - start)
    await writeReport(dir, cases, run)
  }
  if (cases.some(c => c.status === 'error') || run.stopped) process.exitCode = 2
  else if (cases.some(c => c.status === 'fail')) process.exitCode = 1
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'eval failed')
  process.exitCode = 2
})
