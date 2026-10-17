#!/usr/bin/env node
/**
 * 构建一致性门禁（C3 / M10）：lib/ 产物必须与当前 src/ 逐字节对齐。
 * 做法重编译到临时目录再 diff；不一致列出差异文件并退出非零。
 */
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const lib = join(root, 'lib')
const tmp = join(root, '.check-line-tmp')

if (!existsSync(lib)) {
  console.error('check-line: lib/ missing — run `npm run build` first')
  process.exit(1)
}

rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
try {
  execFileSync('node', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json', '--outDir', tmp], {
    cwd: root,
    stdio: 'pipe',
  })
  const diffs = []
  const walk = (dir, base) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(base, full)
      if (statSync(full).isDirectory()) {
        walk(full, base)
        continue
      }
      const counterparty = join(lib, rel)
      if (!existsSync(counterparty)) {
        diffs.push(`only in fresh build: ${rel}`)
        continue
      }
      if (!readFileSync(full).equals(readFileSync(counterparty))) {
        diffs.push(`content differs: ${rel}`)
      }
    }
  }
  walk(tmp, tmp)
  const walkLib = (dir, base) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(base, full)
      if (statSync(full).isDirectory()) {
        walkLib(full, base)
        continue
      }
      // tsdown 客户端产物由 tsdown.client.config.ts 生成，不在 tsc 重编译范围，
      // 逐字节 diff 只约束 tsc 侧（host）产物。跳过 client bundle 及其 map。
      if (rel === 'client.js' || rel === 'client.js.map' || rel === 'client.d.ts') continue
      if (!existsSync(join(tmp, rel))) diffs.push(`stale in lib/: ${rel}`)
    }
  }
  walkLib(lib, lib)
  if (diffs.length > 0) {
    console.error('check-line FAILED: lib/ is out of sync with src/ (run `npm run build`)')
    for (const d of diffs) console.error(`  - ${d}`)
    process.exit(1)
  }
  console.log('check-line OK: lib/ matches a fresh build of src/')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
