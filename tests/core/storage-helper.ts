/** 测试专用：每次使用真实官方 JSON 后端和临时目录，不接触用户的 Harness 数据。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Json from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'

export async function mountStorage(ctx: Context, root?: string): Promise<string> {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'trip-favorites-test-'))
  // 自动临时目录只在整个上下文释放后清理；显式目录由测试持有，以便重新打开。
  if (root === undefined) ctx.effect(() => () => rm(directory, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(Json, { root: directory })
  await ctx.plugin(Domains, { backend: 'json' })
  return directory
}
