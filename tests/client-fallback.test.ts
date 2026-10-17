/**
 * 客户端半身 lazy 兜底两分支的确定性单测（需求 3）：
 *   - 家族所有者在位（账本命中 id='dsh-family'）→ 独立 settings.section 退场（不重复）。
 *   - 家族缺席 → 过 FAMILY_YIELD_MS 窗口后自注册独立 settings.section（保留自注册权利）。
 * 用假 ctx 驱动真实 apply()，注入捕获工厂、账本 entries、假定时器推进窗口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

interface FakeRegistration { name: string; id?: string; key?: string }

function makeCtx(settingsSectionLedger: Array<{ id?: string }>) {
  const registered: FakeRegistration[] = []
  const factories = new Map<string, Array<() => (() => void)>>()
  const ctx = {
    locale: {
      register: () => {},
      addLanguage: () => {},
      bind: () => (key: string): string => key,
    },
    // configForms 服务缺席：仅触发挂载回调，不影响 slots 注册逻辑（卡片闭包不执行）。
    inject: (_deps: string[], _cb: (arg: unknown) => void) => {},
    slots: {
      inject: (slot: string, register: () => (() => void)) => {
        const list = factories.get(slot) ?? []
        list.push(register)
        factories.set(slot, list)
      },
      register: (options: Record<string, unknown>) => {
        registered.push({ name: String(options['name']), id: options['id'] as string | undefined, key: options['key'] as string | undefined })
        return () => {}
      },
      entries: (slot: string): Array<{ id?: string }> => (slot === 'settings.section' ? settingsSectionLedger : []),
    },
  }
  const fire = (slot: string): void => { for (const factory of factories.get(slot) ?? []) factory() }
  return { ctx: ctx as never, registered, fire }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('media-lens client lazy fallback', () => {
  it('家族在位：独立 settings.section 退场，仅贡献 dsh-family.tab', () => {
    const { ctx, registered, fire } = makeCtx([{ id: 'dsh-family' }])
    apply(ctx)
    fire('dsh-family.tab')
    fire('settings.section')
    fire('plugins.bundle.config')
    // 家族贡献卡注册了
    expect(registered.some((r) => r.name === 'dsh-family.tab' && r.id === 'media-lens')).toBe(true)
    // 独立节未注册（快路径账本命中 dsh-family）
    expect(registered.some((r) => r.name === 'settings.section')).toBe(false)
    // bundle 卡始终注册
    expect(registered.some((r) => r.name === 'plugins.bundle.config')).toBe(true)
  })

  it('家族缺席：过让位窗口后自注册独立 settings.section', () => {
    const { ctx, registered, fire } = makeCtx([]) // 账本无 dsh-family
    apply(ctx)
    // 不触发 dsh-family.tab（模拟无家族所有者渲染它）
    fire('settings.section')
    expect(registered.some((r) => r.name === 'settings.section')).toBe(false) // 窗口内尚未注册
    vi.advanceTimersByTime(1500) // 越过 FAMILY_YIELD_MS=1000
    const standalone = registered.find((r) => r.name === 'settings.section')
    expect(standalone).toBeDefined()
    expect(standalone?.id).toBe('media-lens')
  })
})
