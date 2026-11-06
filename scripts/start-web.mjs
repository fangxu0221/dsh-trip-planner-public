/** 以 Harness 源码 CLI 加载本机 overlay，终端日志中的高德 Key 会被遮蔽。 */
import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(project, '../deepseek-harness')
const config = resolve(project, 'cordis.yml')
let key

async function checkedFile(path, message) {
  try { await access(path) }
  catch { throw new Error(message) }
}

try {
  const options = process.argv.slice(2)
  if (options.length > 1 || options.some(option => option !== '--no-open')) {
    throw new Error('可选参数为 --no-open。端口通过 TRIP_WEB_PORT 设置。')
  }
  const port = process.env.TRIP_WEB_PORT ?? '3083'
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error('TRIP_WEB_PORT 必须是 1024 到 65535 之间的整数。')
  }

  const bin = resolve(harness, 'apps/cli/src/bin.ts')
  await checkedFile(bin, '请按 README 把 deepseek-harness 放在同级目录。')
  await checkedFile(resolve(project, 'packages/web/lib/client.js'), '请先运行 pnpm run build:web。')
  await checkedFile(config, '请先运行 pnpm run configure 并填写高德 MCP Key。')

  const require = createRequire(resolve(harness, 'packages/mcp/mcp-client/package.json'))
  const yaml = require('js-yaml')
  try {
    const parsed = yaml.load(await readFile(config, 'utf8'))
    const amap = parsed.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'trip-amap')
    const url = new URL(amap.config.url)
    if (url.origin === 'https://mcp.amap.com' && url.pathname === '/mcp') {
      key = url.searchParams.get('key')
    }
  } catch {
    throw new Error('cordis.yml 无法读取，请对照 cordis.example.yml 检查格式。')
  }
  if (!key || !/^[a-f0-9]{32}$/i.test(key)) throw new Error('请在 cordis.yml 的高德 MCP URL 中填写有效 Key。')

  const child = spawn(process.execPath, ['--import', 'tsx/esm', bin, 'web', '--patch', config, '--port', port, ...options], {
    cwd: harness, stdio: ['inherit', 'pipe', 'pipe'],
  })
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input, crlfDelay: Infinity }).on('line', line => output.write(line.replaceAll(key, '[REDACTED]') + '\n'))
  }
  child.on('error', () => { console.error('无法启动 Harness。'); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  process.once('SIGINT', () => child.kill('SIGINT'))
  process.once('SIGTERM', () => child.kill('SIGTERM'))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
