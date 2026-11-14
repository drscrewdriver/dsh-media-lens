/**
 * tui-command.ts — `/media`：media-lens 的 dsh-tui 终端面。
 *
 * 背景：TUI 不加载设置卡 / 图片卡片，且终端本身不可视 → 「媒体路由到底配没配、
 * 上次走了哪个回退」在终端里无处可查。命令只读回显设置节与最近一次回退信息。
 *
 * 契约：单行 <=100、总行 <=40、无 ANSI、--json 单行。
 */

import type { Context } from '@deepseek-ai/cordis'

export type CommandKind = 'success' | 'error'
export interface CommandResult { kind: CommandKind; text: string }

export interface MediaDeps {
  ns: string
  section(): Record<string, unknown> | undefined
  lastAttempts(): string[]
}

const MAX_LINES = 40
const MAX_WIDTH = 100

export function clip(text: string, width = MAX_WIDTH): string {
  const value = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '')
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

export function renderLines(lines: string[], limit = MAX_LINES): string {
  const clipped = lines.map((line) => clip(line))
  if (clipped.length <= limit) return clipped.join('\n')
  const kept = clipped.slice(0, limit - 1)
  return [...kept, `… 还有 ${clipped.length - kept.length} 行，加 --all 查看`].join('\n')
}

/** 从 settings.describe() 里取本节；找不到就按 needle 回退。 */
export function describeSection(ctx: Context, ns: string, needle = 'endpoints'): Record<string, unknown> | undefined {
  const settings = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as
    | { describe?: () => unknown }
    | undefined
  const raw = settings?.describe?.()
  const list = Array.isArray(raw) ? raw : (raw as { namespaces?: unknown[] } | undefined)?.namespaces
  if (!Array.isArray(list)) return undefined
  for (const entry of list) {
    const row = entry as { ns?: unknown; value?: unknown } | null
    if (row?.ns === ns && row.value !== null && typeof row.value === 'object') return row.value as Record<string, unknown>
  }
  for (const entry of list) {
    const value = (entry as { value?: unknown } | null)?.value
    if (value !== null && typeof value === 'object' && needle in (value as Record<string, unknown>)) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

export function runMediaCommand(rawInput: string, deps: MediaDeps): CommandResult {
  const argv = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const json = argv.includes('--json')
  const sub = (argv.find((token) => !token.startsWith('--')) ?? 'status').toLowerCase()
  const wrap = (result: CommandResult, data: unknown): CommandResult => {
    if (!json) return result
    const body = result.kind === 'error'
      ? { ok: false, cmd: 'media', error: { message: result.text.split('\n')[0] ?? result.text } }
      : { ok: true, cmd: 'media', data }
    return { kind: result.kind, text: JSON.stringify(body) }
  }
  if (sub === 'help' || sub === '?') {
    return wrap({ kind: 'success', text: renderLines([
      'media — 媒体证据路由（只读）',
      '  /media status   设置节 + 最近回退记录',
      '  flags           --json 单行 JSON',
      '  note            终端不可视媒体本身；读图请用 media_read_image 工具',
    ]) }, { help: true })
  }
  if (sub !== 'status') {
    return wrap({ kind: 'error', text: renderLines([`media: 未知子命令 "${sub}"`, '  next: /media help']) }, {})
  }
  const section = deps.section()
  const attempts = deps.lastAttempts()
  const lines = [`media — 设置节 ${section === undefined ? '缺失' : '已加载'}`]
  if (section === undefined) {
    lines.push('  next      插件未进入 profile 文档，或本宿主未挂 settings 服务')
  } else {
    const keys = Object.keys(section)
    for (const key of keys.slice(0, 10)) {
      const value = section[key]
      lines.push(`  ${key.padEnd(18)}  ${clip(typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value), 60)}`)
    }
    if (keys.length > 10) lines.push(`  … 还有 ${keys.length - 10} 个字段`)
  }
  if (attempts.length > 0) {
    lines.push('  last fallbacks')
    for (const attempt of attempts.slice(0, 6)) lines.push(`    ${clip(attempt, 90)}`)
  }
  return wrap({ kind: 'success', text: renderLines(lines) }, { section, attempts })
}

export function registerMediaCommand(ctx: Context, deps: MediaDeps): void {
  const registry = (ctx as unknown as { commands?: { register(definition: unknown): unknown } }).commands
  if (!registry || typeof registry.register !== 'function') return
  registry.register({
    definitionId: 'dsh-media-lens',
    name: 'media',
    description: 'Media lens console: settings section + recent fallback attempts (read-only)',
    input: { hint: '[status] [--json]' },
    handler: (invocation: { rawInput?: string }) => runMediaCommand(invocation?.rawInput ?? '', deps),
  })
}
