/**
 * 链构建（纯函数，M20 断言面）：
 * - image: registered → configured:openai → local:metadata
 * - audio: multimodal → asr:<endpoint>…（FR-3 双路）→ local:metadata
 * - video: full/reencode = multimodal → frames:<image 链> → local:metadata；
 *   sampleFrames = frames:<image 链> → local:metadata
 */

import { basename } from 'node:path'
import type { MediaKind } from '../evidence.ts'
import type { MediaEvidence } from '../evidence.ts'
import type { LensRequest, Provider } from '../router/registry.ts'
import { createLocalFileProvider } from '../providers/local-file.ts'
import { createAsrProvider } from '../providers/asr-shell.ts'
import { createMultimodalProvider } from '../providers/multimodal.ts'
import { createRegisteredProvider } from '../providers/registered.ts'
import { runOpenAiVl, type OpenAiVlConfig } from '../providers/openai-vl.ts'
import { reencode, sampleFrames, cleanupPaths } from '../providers/ffmpeg.ts'
import type { MediaLensConfig } from '../config.ts'
import type { RegisteredDeps } from '../providers/registered.ts'

export interface LensDeps {
  registered: RegisteredDeps
  vlConfig: () => OpenAiVlConfig
  asrEndpoints: () => { name: string; command: string }[]
  strictLocalOnly: () => boolean
  /**
   * Phase 7（FR-15/16）：链出口 refine hook 工厂——未启用时返回 undefined，
   * runChain 行为与 Phase 6 逐字段一致；启用时工具层把它传入 runChain 选项。
   */
  refineFn?: () => ((evidence: MediaEvidence) => Promise<MediaEvidence>) | undefined
}

/** configured:openai provider（baseUrl/model 齐备才 available）。 */
export function createConfiguredOpenAiProvider(vlConfig: () => OpenAiVlConfig): Provider {
  return {
    name: 'configured:openai',
    media: ['image'],
    remote: true,
    available() {
      const c = vlConfig()
      return c.baseUrl.trim() !== '' && c.model.trim() !== '' && c.apiKey.trim() !== ''
    },
    async run(req: LensRequest) {
      return runOpenAiVl(vlConfig(), req)
    },
  }
}

/**
 * 抽帧透镜 provider：任意视频预算 → ffmpeg 均匀抽帧 → 委托图片链
 * （registered image → configured:openai）。帧预算按时长自适应 6–12 帧。
 * full/reencode 预算落到这里 = 直传路不可用，标记 degraded。
 */
export function createFrameLensProvider(imageChain: Provider[]): Provider {
  const name = imageChain[0]?.name ?? 'frames:none'
  return {
    name: `frames:${name}`,
    media: ['video'],
    remote: imageChain.some((p) => p.remote),
    available: () => imageChain.some((p) => p.available()),
    async run(req: LensRequest) {
      if (req.durationSec === undefined) {
        throw new Error('cannot sample frames: duration unknown (ffprobe unavailable?)')
      }
      const count = Math.round(Math.min(12, Math.max(6, req.durationSec / 45)))
      const frames = await sampleFrames(req.path, count, req.durationSec)
      const frameReq: LensRequest = {
        ...req,
        media: 'image',
        budget: 'full',
        frames,
        instruction: req.instruction,
      }
      try {
        for (const provider of imageChain) {
          if (!provider.available()) continue
          const chunk = await provider.run(frameReq)
          return {
            ...chunk,
            kind: 'video',
            source: sourceOf(req),
            meta: {
              ...chunk.meta,
              provider: `frames:${chunk.meta.provider}`,
              ...(req.budget !== 'sampleFrames' ? { degraded: 'direct-send-unavailable-sampled-frames' } : {}),
            },
          }
        }
        throw new Error('no image provider available for sampled frames')
      } finally {
        await cleanupPaths(frames.map((f) => f.path))
      }
    },
  }
}

function sourceOf(req: LensRequest): { path: string; sizeBytes: number; durationSec?: number } {
  return {
    path: req.path,
    sizeBytes: req.sizeBytes,
    ...(req.durationSec !== undefined ? { durationSec: req.durationSec } : {}),
  }
}

/** 重编码 provider：10–19MB 档在直传前的 540p 压缩；输出复用 multimodal 链。 */
export function createReencodeProvider(inner: Provider): Provider {
  return {
    name: `reencode:${inner.name}`,
    media: ['video'],
    remote: inner.remote,
    available: () => inner.available(),
    async run(req: LensRequest) {
      if (req.budget !== 'reencode') throw new Error('reencode provider only handles the reencode budget')
      const out = await reencode(req.path)
      if (out === undefined) throw new Error('ffmpeg reencode failed')
      try {
        const chunk = await inner.run({ ...req, path: out, instruction: req.instruction })
        return {
          ...chunk,
          source: sourceOf(req),
          meta: { ...chunk.meta, provider: `reencode:${chunk.meta.provider}`, degraded: 'reencoded-540p' },
        }
      } finally {
        await cleanupPaths([out])
      }
    },
  }
}

/** strictLocalOnly（FR-7）：开启后链中剔除一切远端成员（M8）。 */
function applyStrict(chain: Provider[], strict: boolean): Provider[] {
  return strict ? chain.filter((p) => !p.remote) : chain
}

/** 构建时裁掉 available()=false 的成员（服务缺失/未配置），local 兜底永远在位。 */
function dropUnavailable(chain: Provider[]): Provider[] {
  return chain.filter((p) => p.available() || p.name === 'local:metadata')
}

/** image 链（不含 local 兜底，供 frame-lens 复用）。 */
export function imageChainRemote(deps: LensDeps): Provider[] {
  return dropUnavailable(applyStrict(
    [createRegisteredProvider(deps.registered, 'image'), createConfiguredOpenAiProvider(deps.vlConfig)],
    deps.strictLocalOnly(),
  ))
}

/** 三个媒体的完整链（含 local 兜底）。 */
export function buildImageChain(deps: LensDeps): Provider[] {
  return [...imageChainRemote(deps), createLocalFileProvider()]
}

export function buildAudioChain(deps: LensDeps): Provider[] {
  const multimodal = createMultimodalProvider(deps.registered, 'audio')
  const asrProviders = deps.asrEndpoints().map((endpoint) => createAsrProvider(endpoint))
  return dropUnavailable(applyStrict([multimodal, ...asrProviders], deps.strictLocalOnly())).concat(createLocalFileProvider())
}

export function buildVideoChain(deps: LensDeps, budget: LensRequest['budget']): Provider[] {
  const multimodal = createMultimodalProvider(deps.registered, 'video')
  const frames = createFrameLensProvider(imageChainRemote(deps))
  const local = createLocalFileProvider()
  const direct = budget === 'sampleFrames'
    ? [frames]
    : budget === 'reencode'
      ? [createReencodeProvider(multimodal), multimodal, frames]
      : [multimodal, frames]
  return dropUnavailable(applyStrict(direct, deps.strictLocalOnly())).concat(local)
}

export function chainForMedia(deps: LensDeps, media: MediaKind, budget: LensRequest['budget']): Provider[] {
  if (media === 'image') return buildImageChain(deps)
  if (media === 'audio') return buildAudioChain(deps)
  return buildVideoChain(deps, budget)
}

/** basename 复出（工具描述用）。 */
export function mediaName(path: string): string {
  return basename(path)
}

export type { MediaLensConfig }
