/** 从公开模板生成本机 overlay。现有配置由使用者维护。 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const template = await readFile(new URL('../cordis.example.yml', import.meta.url), 'utf8')
const entry = path => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)).replaceAll('\\', '/'))
const overlay = template
  .replace('"__TRIP_HOST_ENTRY__"', () => entry('../src/index.ts'))
  .replace('"__TRIP_WEB_ENTRY__"', () => entry('../packages/web/lib/index.js'))

try {
  await writeFile(new URL('../cordis.yml', import.meta.url), overlay, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  console.log('已生成 cordis.yml。请把 YOUR_AMAP_MCP_KEY 替换为自己的 Key。')
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.log('cordis.yml 已存在。请编辑现有配置。')
}
