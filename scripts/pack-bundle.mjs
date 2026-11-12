/** 在临时工作区构建可安装组合包。包内只包含预构建入口、说明及组合包配置。 */
import { execFileSync, execSync } from 'node:child_process'
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const project = fileURLToPath(new URL('../', import.meta.url))
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const json = value => JSON.stringify(value, null, 2) + '\n'
const manifest = await readJson(join(project, 'package.json'))
const supportedDsh = '0.2.2-rc.1'
const sourceDsh = '0.2.2-alpha.2'
const hostManifest = await readJson(join(project, '../deepseek-harness/apps/cli/package.json'))
if (hostManifest.version !== sourceDsh) throw new Error('打包需使用与 README 源码构建步骤一致的 Harness 工作区。')
const require = createRequire(import.meta.url)
const hostPeers = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-typert-protocol']

const temp = join(project, '.tmp')
await mkdir(temp, { recursive: true })
const tempRoot = await realpath(temp)
const stage = await mkdtemp(join(tempRoot, 'trip-pack-'))
try {
  const workspace = join(stage, 'workspace')
  const web = join(workspace, 'packages', 'web')
  const output = join(stage, 'package')
  const lib = join(output, 'lib')
  await Promise.all([mkdir(web, { recursive: true }), mkdir(lib, { recursive: true })])
  const webSource = join(project, 'packages', 'web')
  const webManifest = await readJson(join(webSource, 'package.json'))
  await Promise.all([
    cp(join(project, 'src'), join(workspace, 'src'), { recursive: true }),
    cp(join(webSource, 'src'), join(web, 'src'), { recursive: true }),
    copyFile(join(project, 'tsconfig.json'), join(workspace, 'tsconfig.json')),
    ...['tsconfig.host.json', 'tsconfig.client.json'].map(file => copyFile(join(webSource, file), join(web, file))),
    writeFile(join(web, 'package.json'), json({ ...webManifest, name: manifest.name })),
  ])
  execFileSync(process.execPath, [join(project, 'scripts', 'build-web.mjs'), '--workspace', workspace], { stdio: 'inherit' })

  // 只在包根挂载一个 Loader 条目，由它先加载业务服务，再挂载 Web Host。
  await build({
    absWorkingDir: workspace, platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external',
    stdin: { loader: 'ts', sourcefile: 'bundle-entry.ts', resolveDir: workspace, contents: `
import { apply as applyBackend, inject as backendInject } from './src/index.ts'
import * as web from './packages/web/src/index.ts'
export { Config, name } from './src/index.ts'
export const inject = [...backendInject, 'typert', 'sessions']
export async function apply(ctx, config) {
  await applyBackend(ctx, config)
  await ctx.plugin(web)
}
` },
    outfile: join(lib, 'index.js'),
  })
  // 仓库截图只随 GitHub README 提供，安装包中的说明保留文字教程。
  const readme = await readFile(join(project, 'README.md'), 'utf8')
  const installReadme = readme.replace(/^!\[.*\]\(docs\/screenshots\/[^)\r\n]+\)\r?\n(?:\r?\n)?/gm, '')
  await Promise.all([
    ...['client.js', 'typert.host.js'].map(file => copyFile(join(web, 'lib', file), join(lib, file))),
    writeFile(join(output, 'README.md'), installReadme),
    writeFile(join(output, 'cordis.patch.yml'), '- insert:\n    - id: trip-planner\n      name: ' + manifest.name + '\n'),
    writeFile(join(output, 'package.json'), json({
      name: manifest.name, version: manifest.version, description: manifest.description, type: 'module',
      engines: { node: manifest.engines.node, dsh: supportedDsh },
      files: ['lib', 'cordis.patch.yml'],
      exports: {
        '.': './lib/index.js', './client': './lib/client.js', './typert': './lib/typert.host.js', './package.json': './package.json',
      },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: webManifest.dsh.client },
      // 发布依赖按已安装的官方发行版声明，工作区的 link 依赖只供构建。
      peerDependencies: { '@deepseek-ai/cordis': '4.1.0',
        ...Object.fromEntries(hostPeers.map(name => [name, supportedDsh])),
      },
      dependencies: { '@deepseek-ai/schemastery': '3.19.0', zod: require('zod/package.json').version },
    })),
  ])

  const pack = execSync('npm pack --ignore-scripts --json', {
    cwd: output, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(tempRoot, 'bundle-npm-cache') },
  })
  const metadata = JSON.parse(pack)
  const archive = Array.isArray(metadata) ? metadata[0] : metadata[manifest.name]
  const expected = ['README.md', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js', 'lib/typert.host.js', 'package.json']
  if (archive.files.map(file => file.path).sort().join('\n') !== expected.join('\n')) {
    throw new Error('安装包包含意外文件，请检查打包清单。')
  }
  const destination = join(tempRoot, 'release')
  await mkdir(destination, { recursive: true })
  await copyFile(join(output, archive.filename), join(destination, archive.filename))
  console.log('已生成 ' + join(destination, archive.filename))
} finally {
  if (dirname(await realpath(stage)) === tempRoot) await rm(stage, { recursive: true, force: true })
}
