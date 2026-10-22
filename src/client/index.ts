/**
 * media-lens 客户端半身入口。
 *
 * 纪律（家族节契约 + 双半架构）：
 * - 注册全部发生在 apply 期**顶层**，绝不关在 inject 回调里（两代事故根因）。
 * - 每个 slots 注册走 `ctx.slots.inject` 包装管道（裸 register 的 entry.inject 老壳不解）。
 * - 每处 inject 用 try/catch 守卫：宿主未声明该槽时静默缺席，绝不炸激活。
 * - configForms 经 `ctx.inject(['configForms'], cb)` 取（0.1.7+/0.2.0/0.2.1 权威写路径），
 *   不用顶层 inject（服务不解析会挂死激活）、不裸 ctx.get（审计 cannot get without inject）。
 * - label 在宿主渲染期求值：tNav 于 apply 期 eager bind locale，禁懒取（search-index 0.5.3 事故）。
 *
 * lazy 待注入 / 无注入自注册（需求 3）：家族贡献卡 `dsh-family.tab` 先注册（§5-1 fire 序 =
 * 注册序），其工厂 fire 时置 `familySeated=true`；独立 `settings.section` 工厂读到该标记即退场
 * （家族所有者会渲染本卡），家族槽从未被渲染（无所有者/缺席）时自注册独立节。兜底时序上 farm 实测收敛。
 */
import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { MediaLensSettingsCard, type LensScope } from './MediaLensSettingsCard.tsx'
import { NS, zh, en, extraLanguages } from './locales.ts'
import { resolveConfig, type MediaLensConfig } from '../config.ts'

/** 宿主 client 侧 configForms 面（0.1.7+）。仅声明本插件消费的部分。 */
interface ConfigFormSnapshot {
  status?: string
  value?: { settings?: unknown } | unknown
  revision?: number | null
  writable?: boolean
}
interface ConfigFormHandle {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
  mutate(ops: ReadonlyArray<{ op: 'set'; path: string[]; value: unknown }>, expectedRevision?: number): Promise<boolean>
}
interface ConfigFormsService {
  get(entryId: string): ConfigFormHandle
}

interface SlotsService {
  inject(slot: string, register: () => (() => void) | Generator<() => void>): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
  /** 宿主账本读取（deepseek-harness ui-workspace shortcuts 实证 `slots.entries(name)`）；部分宿主可能无此方法。 */
  entries?(slot: string): Array<Record<string, unknown>>
}
interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, unknown>>): void
  register(ns: string, locale: string, dict: Record<string, unknown>): void
  addLanguage(def: { id: string; label: string; fallback: string }): void
  bind(ns: string): (key: string) => string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotsService
    locale: LocaleService
  }
}

/** 顶层只声明六线通用、且在目标三线（0.1.7+/0.2.0/0.2.1）确证存在的服务。 */
export const inject = ['slots', 'locale'] as const

/** bundle 条目 id（configForms get 的目标）；farm 实测若不符在此定版。 */
const ENTRY_ID = 'dsh-media-lens'

// 家族子 tab 权重（order）：排现存贡献卡之后（靠后）。§1 顶级节 order=40 与本值分属不同层。
const FAMILY_TAB_ORDER = 65
// 独立兜底节 order（settings.section 层，靠后于常规分节）。
const SECTION_ORDER = 24
// 家族所有者落账的让位等待窗口（ms）：晚于此窗口且账本仍无 dsh-family，才自注册独立节。
// 仿 guard/steward 的 yield 语义，消除「contributor 工厂先于 owner 落账」的 fire 时序竞态。
const FAMILY_YIELD_MS = 1000

export function apply(ctx: ClientContext): void {
  // locale：zh|en 内建用双参 register；其余 7 语走单 locale 重载 + addLanguage 才可选。
  try {
    ctx.locale.register(NS, { zh, en })
  } catch (error) {
    console.warn('[dsh-media-lens] locale zh/en 已注册，跳过:', error)
  }
  for (const language of extraLanguages) {
    try {
      ctx.locale.register(NS, language.id, language.dict)
      ctx.locale.addLanguage({ id: language.id, label: language.label, fallback: 'en' })
    } catch (error) {
      console.warn(`[dsh-media-lens] locale "${language.id}" 注册失败，跳过:`, error)
    }
  }
  const tNav = ctx.locale.bind(NS)

  // configForms 臂：ctx.inject 解析（服务到达时回调），解析前卡片走 loading/只读。
  let configForms: ConfigFormsService | undefined
  try {
    ctx.inject(['configForms'], (arg) => {
      const svc = (arg as { configForms?: ConfigFormsService }).configForms ?? (arg as unknown as ConfigFormsService)
      configForms = typeof (svc as ConfigFormsService | undefined)?.get === 'function' ? svc : undefined
    })
  } catch (error) {
    console.warn('[dsh-media-lens] configForms 臂挂载失败（卡片降级只读）:', error)
  }

  const decode = (raw: unknown): MediaLensConfig | undefined => {
    const doc = raw !== null && typeof raw === 'object' && 'settings' in (raw as Record<string, unknown>)
      ? (raw as { settings?: unknown }).settings
      : raw
    if (doc === undefined || doc === null) return undefined
    return resolveConfig(doc as Parameters<typeof resolveConfig>[0])
  }

  const makeScope = (): LensScope => {
    if (configForms === undefined) {
      return { subscribe: () => () => {}, getSnapshot: () => ({ status: 'loading' }), commit: async () => false }
    }
    let form: ConfigFormHandle
    try {
      form = configForms.get(ENTRY_ID)
    } catch (error) {
      console.warn('[dsh-media-lens] configForms.get(ENTRY_ID) 失败（卡片降级只读）:', error)
      return { subscribe: () => () => {}, getSnapshot: () => ({ status: 'loading' }), commit: async () => false }
    }
    // getSnapshot 必须返回稳定引用（useSyncExternalStore 幂等），按原始快照身份缓存投影。
    let source: ConfigFormSnapshot | undefined
    let projected: { status: string; value?: MediaLensConfig; writable?: boolean } = { status: 'loading', writable: false }
    return {
      subscribe: (listener) => form.subscribe(listener),
      getSnapshot: () => {
        const snap = form.getSnapshot()
        if (snap !== source) {
          source = snap
          projected = {
            status: snap.status ?? 'loading',
            value: decode(snap.value),
            writable: snap.writable ?? false,
          }
        }
        return projected
      },
      commit: async (next) => {
        try {
          // 单次原子 mutate：五个顶层 volatile 字段一次提交（避免多个并发 set 的
          // revision 竞态；models/providers/refine 整体子树各为一个固定路径）。
          // typeof 守卫：部分宿主形态只提供 set，无 mutate → 回落逐字段 set。
          if (typeof form.mutate === 'function') {
            return await form.mutate([
              { op: 'set', path: ['strictLocalOnly'], value: next.strictLocalOnly },
              { op: 'set', path: ['cooldownMs'], value: next.cooldownMs },
              { op: 'set', path: ['models'], value: next.models },
              { op: 'set', path: ['providers'], value: next.providers },
              { op: 'set', path: ['refine'], value: next.refine },
              { op: 'set', path: ['inject'], value: next.inject },
            ])
          }
          const results = await Promise.all([
            form.set('strictLocalOnly', next.strictLocalOnly),
            form.set('cooldownMs', next.cooldownMs),
            form.set('models', next.models),
            form.set('providers', next.providers),
            form.set('refine', next.refine),
            form.set('inject', next.inject),
          ])
          return results.every(Boolean)
        } catch (error) {
          console.warn('[dsh-media-lens] 写入失败:', error)
          return false
        }
      },
    }
  }

  const card = () => createElement(MediaLensSettingsCard, { scope: makeScope(), t: tNav })

  // lazy 兜底标记：家族贡献卡工厂一旦被渲染（fire）即置位。
  let familySeated = false

  /**
   * 家族所有者是否已在位（据「查账本」判定，不依赖本地 fire 时序）：
   * settings.section 席位里已有 id='dsh-family' 的条目 → 所有者接管家族节 → 本卡只作贡献 tab，
   * 独立节退场（避免重复展示）。本地 familySeated 标记作次级信号。
   */
  const hasFamilyOwner = (): boolean => {
    if (familySeated) return true
    const read = ctx.slots.entries
    if (typeof read !== 'function') return false
    try {
      return read.call(ctx.slots, 'settings.section').some((entry) => (entry as { id?: unknown }).id === 'dsh-family')
    } catch {
      return false
    }
  }

  // 1) 家族子 tab 贡献卡（主路，权重靠后）——先注册，保证 fire 序在独立节之前。
  try {
    ctx.slots.inject('dsh-family.tab', () => {
      familySeated = true
      return ctx.slots.register({
        name: 'dsh-family.tab',
        id: 'media-lens',
        order: FAMILY_TAB_ORDER,
        label: () => tNav('familyTabLabel'),
        locale: NS,
      }, card)
    })
  } catch (error) {
    console.warn('[dsh-media-lens] dsh-family.tab 注册失败（本宿主无家族槽，独立节兜底）:', error)
  }

  // 2) 独立兜底节：延迟裁决——家族所有者在窗口内落账则退场；窗口后账本仍无 dsh-family 才自注册。
  try {
    ctx.slots.inject('settings.section', () => {
      // 快路径：家族所有者已在前序 fire 落账 → 立即退场。
      if (hasFamilyOwner()) return () => {}
      let registeredOff: (() => void) | undefined
      const timer = setTimeout(() => {
        // 窗口后再查一次：家族落账则放弃，缺席才保留「自己注册 insection」的权利。
        if (hasFamilyOwner()) return
        const off = ctx.slots.register({
          name: 'settings.section',
          id: 'media-lens',
          order: SECTION_ORDER,
          label: () => tNav('nav'),
          locale: NS,
        }, card)
        registeredOff = typeof off === 'function' ? off : undefined
      }, FAMILY_YIELD_MS)
      return () => {
        clearTimeout(timer)
        if (registeredOff !== undefined) { try { registeredOff() } catch { /* ignore */ } }
      }
    })
  } catch (error) {
    console.warn('[dsh-media-lens] settings.section 注册失败（宿主无该槽，静默缺席）:', error)
  }

  // 3) bundle 详情卡（0.1.7+ keyed 槽，key=包名）。老宿主无槽 try/catch 吞掉。
  try {
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: 'dsh-media-lens',
      locale: NS,
    }, card))
  } catch (error) {
    console.warn('[dsh-media-lens] plugins.bundle.config 注册失败（旧宿主无该槽，静默缺席）:', error)
  }
}
