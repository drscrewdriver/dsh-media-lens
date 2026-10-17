/**
 * 注册模型发现（FR-9）：枚举宿主 llm runtime 里已注册的 provider 路由与模型，
 * 按模态能力分组，构成各媒体链的首选段。
 *
 * 宿主侧接口（0.2.0-rc.2 实查）：`ctx.llm.listProviders()`（同步）→
 * `listModels(provider)` → `LlmModelInfo { id, name, inputModalities? }`。
 * 宿主模态词表只认 `text | image`（ModelModalityMap），视频/音频组通常为空 ——
 * MiMo 类全模态模型通过 `models.{video,audio}: 'provider/model'` 显式选择接入，
 * 实际承载由适配器模态硬闸把关（响亮拒绝，不静默）。
 *
 * 宿主 service 依赖全部软读（spec C2）：llm 缺失/异常 → available:false，
 * 不 throw，链自然回落自配端点。
 */

import type { MediaKind } from './evidence.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

/** 结构化最小面（便于测试注入假 llm）。 */
export interface LlmDiscoveryFace {
  listProviders(): { id: string; name?: string }[] | Promise<{ id: string; name?: string }[]>
  listModels(provider: string): Promise<unknown[]>
}

export interface DiscoveredModel {
  provider: string
  id: string
  name: string
  /** 运行时鸭子类型：宿主词表当前 text|image，将来扩展自动跟进。 */
  modalities: string[]
}

export interface DiscoverySnapshot {
  /** false = 宿主 llm service 缺失或枚举失败（软降级，链回落自配端点）。 */
  available: boolean
  models: DiscoveredModel[]
  groups: Record<MediaKind, DiscoveredModel[]>
}

export const EMPTY_SNAPSHOT: DiscoverySnapshot = {
  available: false,
  models: [],
  groups: { image: [], audio: [], video: [] },
}

const PROVIDER_SCAN_LIMIT = 32

function modalityList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((m): m is string => typeof m === 'string')
}

function groupByKind(models: DiscoveredModel[]): Record<MediaKind, DiscoveredModel[]> {
  const groups: Record<MediaKind, DiscoveredModel[]> = { image: [], audio: [], video: [] }
  for (const model of models) {
    if (model.modalities.includes('image')) groups.image.push(model)
    if (model.modalities.includes('audio')) groups.audio.push(model)
    if (model.modalities.includes('video')) groups.video.push(model)
  }
  return groups
}

/** 枚举已注册模型；任何一步失败都折返 EMPTY_SNAPSHOT（软读纪律）。 */
export async function discoverRegisteredModels(llm: LlmDiscoveryFace | undefined, log?: (m: string) => void): Promise<DiscoverySnapshot> {
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    log?.('[media-lens] llm service unavailable: registered-model discovery disabled')
    return EMPTY_SNAPSHOT
  }
  try {
    const providersRaw = await llm.listProviders()
    const providers = (Array.isArray(providersRaw) ? providersRaw : [])
      .map((p) => String((p as { id?: unknown })?.id ?? ''))
      .filter((id) => id !== '')
      .slice(0, PROVIDER_SCAN_LIMIT)
    const models: DiscoveredModel[] = []
    for (const provider of providers) {
      try {
        const listed = await llm.listModels(provider)
        for (const raw of Array.isArray(listed) ? listed : []) {
          const entry = raw as { id?: unknown; name?: unknown; inputModalities?: unknown }
          const id = typeof entry?.id === 'string' ? entry.id : ''
          if (id === '') continue
          models.push({
            provider,
            id,
            name: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : id,
            modalities: modalityList(entry?.inputModalities),
          })
        }
      } catch (err) {
        log?.(`[media-lens] listModels(${provider}) failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { available: true, models, groups: groupByKind(models) }
  } catch (err) {
    log?.(`[media-lens] discovery failed: ${err instanceof Error ? err.message : String(err)}`)
    return EMPTY_SNAPSHOT
  }
}

export interface ModelSelection {
  provider: string
  model: string
  /** 'explicit' = 用户配置指定（即使模态未声明也尊重）；'auto' = discovery 首个。 */
  source: 'explicit' | 'auto'
}

/**
 * 解析某媒体的处理端：显式 `provider/model` 优先（用户裁决高于 discovery）；
 * auto 取分组首个；无可用模型返回 undefined（链里跳过该路）。
 */
export function resolveSelection(
  snapshot: DiscoverySnapshot,
  kind: MediaKind,
  selection: string | undefined,
): ModelSelection | undefined {
  const trimmed = selection?.trim() ?? ''
  if (trimmed !== '' && trimmed !== 'auto') {
    const slash = trimmed.indexOf('/')
    if (slash > 0 && slash < trimmed.length - 1) {
      return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1), source: 'explicit' }
    }
  }
  const first = snapshot.groups[kind][0]
  return first === undefined ? undefined : { provider: first.provider, model: first.id, source: 'auto' }
}

/** 供注入：从宿主上下文软读 llm runtime（无则 undefined）。 */
export function softReadLlm(ctx: unknown): LlmRuntime | undefined {
  try {
    const llm = (ctx as { get?: (key: string) => unknown }).get?.('llm')
    return (llm ?? undefined) as LlmRuntime | undefined
  } catch {
    return undefined
  }
}
