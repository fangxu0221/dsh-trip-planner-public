/** 生成 Typert 协议，再分别构建 Host ESM 和 Harness 的浏览器模块。 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, 'packages/web')
const { name } = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
const require = createRequire(import.meta.url)
const typecheck = face => execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p',
  resolve(directory, `tsconfig.${face}.json`)], { stdio: 'inherit' })

typecheck('host')

// 官方分析器按工作区包身份识别装饰器；这里只准备声明文件供分析，不复制运行时。
const protocolTypes = resolve(root, 'packages/.protocol-types')
const protocol = dirname(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'))
await mkdir(protocolTypes, { recursive: true })
await cp(resolve(protocol, 'lib/types'), protocolTypes, { recursive: true })
await writeFile(resolve(protocolTypes, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-typert-protocol', type: 'module', exports: { '.': { types: './index.d.ts' } },
}))
await writeFile(resolve(protocolTypes, 'tsconfig.json'), JSON.stringify({ files: ['index.d.ts'] }))
const compilerOptions = JSON.parse(await readFile(resolve(root, 'tsconfig.json'), 'utf8')).compilerOptions
await writeFile(resolve(root, 'tsconfig.web-analysis.json'), JSON.stringify({
  compilerOptions: { ...compilerOptions, lib: ['ES2024', 'ESNext.Disposable', 'DOM'],
    paths: { '@deepseek-ai/dsh-typert-protocol': ['./packages/.protocol-types/index.d.ts'] } },
  files: [], references: [{ path: './packages/web/tsconfig.host.json' }, { path: './packages/.protocol-types/tsconfig.json' }],
}))
const workspace = new WorkspaceAnalyzer({ root, hostConfig: 'tsconfig.web-analysis.json',
  clientConfig: 'tsconfig.no-client.json', faces: ['host'], packages: [name], checkDiagnostics: false }).analyze()
const host = workspace.faces.find(face => face.face === 'host')
if (!host) throw new Error('未发现出行面板的 Host 编译面。')
const artifact = new FaceModelEmitter(host).emit(name)
if (!artifact.remote) throw new Error('未生成出行面板的 Typert Remote 接口。')
writePackageArtifacts(directory, [{ ...artifact, packageRoot: 'packages/web' }])

typecheck('client')
await build({ absWorkingDir: directory, entryPoints: ['src/index.ts', 'src/types.ts'], outdir: 'lib',
  platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external', sourcemap: true })
const client = await build({ absWorkingDir: directory, entryPoints: ['src/client/index.tsx'],
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic', bundle: true, write: false,
  external: ['react', 'react/jsx-runtime', 'zod', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-gateway/client'],
})
// React、Store 和协议校验依赖由 Harness 的浏览器模块加载器提供。
await writeFile(resolve(directory, 'lib/client.js'), [
  'window.__ModuleLoader__.load({', 'id: ' + JSON.stringify(name) + ',',
  'factory: (require) => {', 'var module = { exports: {} }; var exports = module.exports;',
  client.outputFiles[0].text, 'return module.exports;', '}', '});', '',
].join('\n'))
console.log('出行面板 Host、Typert Remote 与浏览器 bundle 已构建。')
