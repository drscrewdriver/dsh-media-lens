/**
 * dsh-media-lens host 入口：注册 media_read_video / media_read_audio /
 * media_read_image 三个工具 + 配置 schema。
 *
 * 纪律（spec C2）：
 * - 宿主 service 全部 ctx.get() 软读 —— tools/llm/attachments 任一缺失只降级
 *   （不注册工具或禁用对应链路），绝不阻塞插件装载；
 * - 不做任何 UI / 客户端半身（YAGNI，spec 决策记录）。
 *
 * 触发（FR-8）：工具描述含扩展名触发词，模型读到媒体路径即自动调用。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { discoverRegisteredModels, filterDiscoverySnapshot, type DiscoverySnapshot, type LlmDiscoveryFace } from './discovery.ts'
import { resolveConfig, type MediaLensConfigInput } from './config.ts'
import { CooldownGate } from './router/failover.ts'
import { refineEvidence } from './refine.ts'
import { wireModelsRoute } from './models-route.ts'
import { createVisionBridge, OWN_PROVIDER_PREFIX } from './inject.ts'
import type { RegisteredDeps } from './providers/registered.ts'
import type { LensDeps } from './tools/chains.ts'
import { createReadImageTool } from './tools/read-image.ts'
import { createReadAudioTool } from './tools/read-audio.ts'
import { createReadVideoTool } from './tools/read-video.ts'

export const name = 'dsh-media-lens'

export const Config = z.object({
  strictLocalOnly: z.boolean().default(false).volatile(),
  cooldownMs: z.number().default(600_000).volatile(),
  models: z.object({
    image: z.string().default('auto'),
    audio: z.string().default('auto'),
    video: z.string().default('auto'),
  }).volatile(),
  providers: z.object({
    openai: z.object({
      baseUrl: z.string().default(''),
      apiKey: z.string().default(''),
      model: z.string().default(''),
      structuredOutput: z.boolean().default(false),
    }),
    asr: z.object({
      command: z.string().default(''),
      endpoints: z.array(z.string()).default([]),
    }),
  }).volatile(),
  // Phase 7 (FR-15)：链出口 refine pass，默认关；model 必须显式 'provider/model'。
  refine: z.object({
    enabled: z.boolean().default(false),
    model: z.string().default(''),
  }).volatile(),
  // vision-bridge (v4)：选择器可见的透镜包装 provider，默认关（额外注册面 + 改写暴露面）。
  inject: z.object({
    enabled: z.boolean().default(false),
    families: z.array(z.string()).default(['deepseek', 'glm', 'mimo']),
  }).volatile(),
})

interface ToolsFace {
  register(tool: ToolDefinition): void
}

const DISCOVERY_TTL_MS = 60_000

export function apply(ctx: Context, config: MediaLensConfigInput = {}): void {
  // volatile 活读：宿主对 `.volatile()` 字段传带 `.get()` 的活引用，且写入后只发
  // `loader/volatile-update` 事件、不重跑 apply（llm-pi-ai / llm-deepseek 同范式）。
  // resolved 必须可整体重算——下方闭包全部在调用期解引用 `resolved`，重算即热生效。
  let resolved = resolveConfig(config)
  const log = (message: string): void => {
    try {
      (ctx as unknown as { logger?: { info?: (m: string) => void; warn?: (m: string) => void } })
        .logger?.info?.(message)
    } catch { /* 日志绝不允许破坏宿主 */ }
  }

  // 软读 tools：缺失则无立足点，warn 后退出（不阻塞宿主其它插件）。
  let tools: ToolsFace | undefined
  try {
    tools = ctx.get('tools') as ToolsFace | undefined
  } catch {
    tools = undefined
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    log('[media-lens] tools service unavailable: skip tool registration')
    return
  }
  const llm = softRead<LlmRuntime>(ctx, 'llm')
  const attachments = softRead<AttachmentStore>(ctx, 'attachments')

  log(`[media-lens] services: llm=${llm !== undefined} attachments=${attachments !== undefined} strictLocalOnly=${String(resolved.strictLocalOnly)}`)

  // discovery 快照：apply 时即起一次后台枚举，此后 TTL 内复用缓存；llm 缺失 →
  // available:false（软读降级），链回落自配端点。枚举未完成的首批调用走空快照。
  const emptySnapshot = (): DiscoverySnapshot => ({ available: llm !== undefined, models: [], groups: { image: [], audio: [], video: [] } })
  let cached: { snapshot: DiscoverySnapshot; at: number } | undefined
  const refresh = (): void => {
    if (llm === undefined) return
    void discoverRegisteredModels(llm as unknown as LlmDiscoveryFace, log)
      .then((fresh) => {
        // vision-bridge 自排除：wrapper 注册后自己也在宿主注册表里，读手/候选
        // 一律看不到 `media-lens-vision-*`（否则 auto 选择会递归选到自己）。
        cached = { snapshot: filterDiscoverySnapshot(fresh, (model) => !model.provider.startsWith(OWN_PROVIDER_PREFIX)), at: Date.now() }
      })
      .catch(() => { /* 软读纪律：刷新失败维持现状 */ })
  }
  refresh()
  const snapshot = (): DiscoverySnapshot => {
    if (cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.snapshot
    refresh()
    return cached?.snapshot ?? emptySnapshot()
  }

  const registeredDeps: RegisteredDeps = {
    llm,
    attachments,
    snapshot,
    selectionFor: (kind) => resolved.models[kind],
  }

  // 已注册模型候选路由：供客户端设置卡把「处理端模型」渲染成可选候选（无 webServer 静默缺席）。
  wireModelsRoute(ctx, snapshot, log)

  const deps: LensDeps = {
    registered: registeredDeps,
    vlConfig: () => resolved.providers.openai,
    asrEndpoints: () => {
      const endpoints = [...resolved.providers.asr.endpoints]
      if (resolved.providers.asr.command.trim() !== '') {
        endpoints.unshift(resolved.providers.asr.command)
      }
      return endpoints.map((command, index) => ({ name: `endpoint-${index + 1}`, command }))
    },
    strictLocalOnly: () => resolved.strictLocalOnly,
    // Phase 7 + refine-source-gate：refine hook 工厂——enabled 且 model 非空且
    // configured 端点（providers.openai）在位才给闭包；其余情形（含 auto/空串、
    // 未自配端点）返回 undefined，行为退到 Phase 6 逐字段一致。
    refineFn: () => {
      if (resolved.refine.enabled !== true) return undefined
      const selection = resolved.refine.model.trim()
      if (selection === '' || selection === 'auto') return undefined
      const endpoint = resolved.providers.openai
      if (endpoint.baseUrl.trim() === '' || endpoint.apiKey.trim() === '') return undefined
      return (evidence) => refineEvidence(evidence, {
        vlEndpoint: endpoint,
        selection,
        secrets: [endpoint.apiKey, endpoint.baseUrl],
      })
    },
  }

  const gate = new CooldownGate(resolved.cooldownMs)
  const register = (tool: ToolDefinition): void => {
    try {
      tools!.register(tool)
      log(`[media-lens] registered ${tool.name}`)
    } catch (err) {
      log(`[media-lens] register failed for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  register(createReadVideoTool(deps, gate, log))
  register(createReadAudioTool(deps, gate, log))
  register(createReadImageTool(deps, gate, log))

  // vision-bridge (v4)：默认关。开启且 llm 在位时注册包装 provider
  //（`media-lens-vision-<upstream>`，选择器出现 `(media-lens vision)` 条目）。
  // llm 缺失 / registerAdapter 面缺失时桥静默不启动（C2 软读降级，纯工具形态）。
  const bridge = llm !== undefined
    ? createVisionBridge({
      ctx,
      llm,
      deps,
      gate,
      families: () => resolved.inject.families,
      enabled: () => resolved.inject.enabled,
      log,
    })
    : undefined
  bridge?.start()

  // loader/volatile-update：volatile 字段写入后重算 resolved（cell .get() 取到新值）
  // 并让桥重扫（enabled / families / 处理端模型 / 端点配置全部即时生效，无需重载）。
  // 事件名不在 cordis 基础 Events 词表内，duck-type 订阅（照 models-route 软读纪律）。
  const events = ctx as unknown as { on?: (event: string, listener: () => void) => unknown }
  try {
    events.on?.('loader/volatile-update', () => {
      resolved = resolveConfig(config)
      log(`[media-lens] config hot-reloaded: inject=${String(resolved.inject.enabled)} strictLocalOnly=${String(resolved.strictLocalOnly)}`)
      void bridge?.sweep()
    })
  } catch { /* 事件面缺失：配置变更需重载插件（与 v4 之前行为一致） */ }
}

function softRead<T>(ctx: Context, key: string): T | undefined {
  try {
    return (ctx.get(key) ?? undefined) as T | undefined
  } catch {
    return undefined
  }
}

export { resolveConfig, DEFAULT_CONFIG, parseModelSelection } from './config.ts'
export type { MediaLensConfig } from './config.ts'
export { validateEvidence, serializeEvidence, deserializeEvidence, finalizeChunk, makeChunk } from './evidence.ts'
export type { MediaEvidence, Attempt, Chunk, MediaKind } from './evidence.ts'
export { AllProvidersFailed, CooldownGate, runChain } from './router/failover.ts'
export { ProviderRegistry } from './router/registry.ts'
export { decideBudget } from './router/budget.ts'
export { discoverRegisteredModels, filterDiscoverySnapshot, resolveSelection } from './discovery.ts'
export { refineEvidence, EVIDENCE_REFINE_INSTRUCTION } from './refine.ts'
export type { RefineDeps } from './refine.ts'
export { createVisionBridge, shouldWrapModel, evidenceBridgeText, fileHandlePath, rewriteMessages, EvidenceMemo, BRIDGE_FAILURES, OWN_PROVIDER_PREFIX, VISION_MODEL_SUFFIX } from './inject.ts'
export type { VisionBridge, VisionBridgeInput } from './inject.ts'
