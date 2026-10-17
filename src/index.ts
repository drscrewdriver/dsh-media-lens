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
import { discoverRegisteredModels, type DiscoverySnapshot, type LlmDiscoveryFace } from './discovery.ts'
import { resolveConfig, type MediaLensConfigInput } from './config.ts'
import { CooldownGate } from './router/failover.ts'
import { refineEvidence } from './refine.ts'
import { wireModelsRoute } from './models-route.ts'
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
})

interface ToolsFace {
  register(tool: ToolDefinition): void
}

const DISCOVERY_TTL_MS = 60_000

export function apply(ctx: Context, config: MediaLensConfigInput = {}): void {
  const resolved = resolveConfig(config)
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
      .then((fresh) => { cached = { snapshot: fresh, at: Date.now() } })
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
    // Phase 7：refine hook 工厂——enabled 且 model 非空且 llm 在位才给闭包；
    // 其余情形（包括 auto/空串）返回 undefined，行为退到 Phase 6 逐字段一致。
    refineFn: () => {
      if (resolved.refine.enabled !== true) return undefined
      const selection = resolved.refine.model.trim()
      if (selection === '' || selection === 'auto') return undefined
      if (llm === undefined) return undefined
      return (evidence) => refineEvidence(evidence, {
        llm,
        snapshot,
        selection,
        secrets: [resolved.providers.openai.apiKey, resolved.providers.openai.baseUrl],
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
export { discoverRegisteredModels, resolveSelection } from './discovery.ts'
export { refineEvidence, EVIDENCE_REFINE_INSTRUCTION } from './refine.ts'
export type { RefineDeps } from './refine.ts'
