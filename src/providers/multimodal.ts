/**
 * 全模态路（FR-2/FR-3 用户 10-06 修正落点）：Gemini/MiMo 类原生音视频解析模型，
 * 经注册模型调用（callRegisteredModel 核心，file 块直传）。
 *
 * 选择逻辑：`models.{video,audio}` 显式 `'provider/model'` 直接尊重；`auto` 时
 * 取 discovery 音/视频分组首个（宿主词表当前封顶 text|image，分组通常为空 →
 * provider 不可用，链自然落到抽帧/ASR 兜底 —— 不硬造直传）。
 * MiMo 接线形态参考残留工具 dsh-video-read（仅设计参考，不采纳其会话注入机制）。
 */

import type { Chunk, MediaKind } from '../evidence.ts'
import type { LensRequest, Provider } from '../router/registry.ts'
import type { DiscoverySnapshot, ModelSelection } from '../discovery.ts'
import { resolveSelection } from '../discovery.ts'
import { callRegisteredModel, type RegisteredDeps } from './registered.ts'

function providerNameFor(selection: ModelSelection): string {
  return `multimodal:${selection.provider}/${selection.model}`
}

/** 音/视频直传 provider 工厂（M20：audio 链 multimodal → asr-shell；video full/reencode 直传首选）。 */
export function createMultimodalProvider(deps: RegisteredDeps, kind: Extract<MediaKind, 'audio' | 'video'>): Provider {
  return {
    name: 'multimodal:auto',
    media: [kind],
    remote: true,
    available() {
      return deps.llm !== undefined
        && deps.attachments !== undefined
        && resolveSelection(deps.snapshot(), kind, deps.selectionFor(kind)) !== undefined
    },
    async run(req: LensRequest, signal?: AbortSignal): Promise<Chunk> {
      const selection = resolveSelection(deps.snapshot(), kind, deps.selectionFor(kind))
      if (selection === undefined) throw new Error(`no registered multimodal model selected for ${kind}`)
      const chunk = await callRegisteredModel(deps, selection, req, signal)
      return { ...chunk, meta: { ...chunk.meta, provider: providerNameFor(selection) } }
    },
  }
}

/** 发现快照持有者（index.ts 组装一次，provider 们共享）。 */
export interface SnapshotHolder {
  snapshot: DiscoverySnapshot
}

/** 给测试/工具层用的快照 getter 包装。 */
export function snapshotGetter(holder: SnapshotHolder): () => DiscoverySnapshot {
  return () => holder.snapshot
}
