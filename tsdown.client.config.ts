import { defineConfig } from 'tsdown'

// media-lens 客户端半身浏览器 bundle 打包配置：
//   - 输出单个 CJS `lib/client.js`，用 banner/footer 闭包成宿主
//     `window.__ModuleLoader__.load({ id, factory })` 形态（id 必须等于 npm 包名，
//     否则 client 半整体静默失活）。
//   - react / react/jsx-runtime / @deepseek-ai/dsh-client-* / @deepseek-ai/cordis
//     为 external，由宿主运行时 require 提供，绝不打包进 bundle（否则双 react）。
//   - 无 CSS module（卡片走内联主题令牌 style），故不引 lightningcss。
const PLUGIN_ID = 'dsh-media-lens'
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  clean: false,
  fixedExtension: false,
  hash: false,
  sourcemap: false,
  deps: {
    neverBundle: (specifier) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier) => !CLIENT_EXTERNALS.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
