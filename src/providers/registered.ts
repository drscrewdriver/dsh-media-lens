/**
 * 注册模型处理端（FR-5/FR-9 首选路）：把宿主已注册模型当作媒体处理端，
 * 经 `ctx.llm.stream(GenerateOptions)` 直调。图片走 saveImage 原生 image 块；
 * 音视频走 saveFile file 块 —— 在 openai-completions 接管线上由适配器序列化成
 * video_url / input_audio（模态硬闸拒绝是响亮的）；未接管线路宿主把 file 块
 * 投影成 handle 文本，直传回执因此必须有结构化证据，否则视为"没真正看到媒体"
 * 并 throw 落到抽帧/ASR 兜底。
 */

import type { AttachmentStore, FileAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, LlmRuntime, RequestMessage } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Chunk, MediaKind } from '../evidence.ts'
import { makeChunk } from '../evidence.ts'
import type { LensRequest, Provider } from '../router/registry.ts'
import type { DiscoverySnapshot, ModelSelection } from '../discovery.ts'
import { resolveSelection } from '../discovery.ts'
import { evidenceFromModelJson, extractJsonBlock } from './evidence-parse.ts'
import { EVIDENCE_INSTRUCTION, imageMediaType } from './openai-vl.ts'

/** saveImage 词表（bmp 不在内：这类图片由 configured 端点兜）。 */
const SAVEABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export interface RegisteredDeps {
  llm: LlmRuntime | undefined
  attachments: AttachmentStore | undefined
  /** 返回当前 discovery 快照（工具层缓存刷新）。 */
  snapshot: () => DiscoverySnapshot
  /** models.{image,audio,video} 选择串。 */
  selectionFor: (kind: MediaKind) => string | undefined
}

const HANDLE_TEXT_MARKERS = ['read it on demand', 'verbatim stored copy', 'stored verbatim']

/**
 * 直调一次注册模型并解析证据。
 * - 音视频：JSON 证据必需 —— 解析失败/内容是 handle 回声 → throw（链继续）。
 * - 图片：JSON 失败可裸文本 regions 降级（VL 描述仍有引用价值）。
 */
export async function callRegisteredModel(
  deps: RegisteredDeps,
  selection: ModelSelection,
  req: LensRequest,
  signal?: AbortSignal,
): Promise<Chunk> {
  if (deps.llm === undefined) throw new Error('llm service unavailable')
  if (deps.attachments === undefined) throw new Error('attachments service unavailable')

  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `${EVIDENCE_INSTRUCTION}${req.instruction !== undefined ? ` Focus: ${req.instruction}` : ''}`,
  }]

  const providerName = `${req.media === 'image' ? 'registered' : 'multimodal'}:${selection.provider}/${selection.model}`

  if (req.media === 'image') {
    const mediaType = imageMediaType(req.path)
    if (mediaType === undefined || !SAVEABLE_IMAGE_TYPES.has(mediaType)) {
      throw new Error(`registered route cannot ingest ${mediaType ?? 'this image type'} (attachment wordlist: png/jpeg/webp/gif)`)
    }
    const data = await readFile(req.path)
    const ref = await deps.attachments.saveImage({ data, mediaType: mediaType as ImageMediaType, name: basename(req.path) })
    blocks.push({ type: 'image', attachment: ref })
  } else {
    const data = await readFile(req.path)
    const ref: FileAttachmentRef = await deps.attachments.saveFile({ data, name: basename(req.path) })
    blocks.push({ type: 'file', attachment: ref })
  }

  const messages: RequestMessage[] = [{ role: 'user', content: blocks }]
  let text = ''
  for await (const chunk of deps.llm.stream({
    provider: selection.provider,
    model: selection.model,
    messages,
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'max-tokens') {
      throw new Error(`registered model finished with ${chunk.reason.kind}`)
    }
  }

  const parsed = extractJsonBlock(text)
  const chunk = parsed !== undefined
    ? evidenceFromModelJson(parsed, req.media, evidenceSource(req), providerName)
    : undefined
  if (chunk !== undefined) return chunk
  if (req.media === 'image' && text.trim() !== '') {
    return makeChunk({
      kind: 'image',
      source: evidenceSource(req),
      regions: [{ text, kind: 'description' }],
      meta: { provider: providerName, degraded: 'unstructured-response' },
    })
  }
  const echoedHandle = HANDLE_TEXT_MARKERS.some((marker) => text.includes(marker))
  throw new Error(
    echoedHandle
      ? 'registered model only saw a file handle (route did not ingest media natively); falling through'
      : `registered model response had no parsable evidence (${text.trim().length} chars)`,
  )
}

function evidenceSource(req: LensRequest): Chunk['source'] {
  return {
    path: req.path,
    sizeBytes: req.sizeBytes,
    ...(req.durationSec !== undefined ? { durationSec: req.durationSec } : {}),
  }
}

/** 图片路注册模型 provider（available = 有可选模型 + 服务在位）。 */
export function createRegisteredProvider(deps: RegisteredDeps, kind: Extract<MediaKind, 'image'>): Provider {
  return {
    name: 'registered:auto',
    media: [kind],
    remote: true,
    available() {
      return deps.llm !== undefined
        && deps.attachments !== undefined
        && resolveSelection(deps.snapshot(), kind, deps.selectionFor(kind)) !== undefined
    },
    async run(req: LensRequest, signal?: AbortSignal): Promise<Chunk> {
      const selection = resolveSelection(deps.snapshot(), kind, deps.selectionFor(kind))
      if (selection === undefined) throw new Error('no registered model selected for image')
      const chunk = await callRegisteredModel(deps, selection, req, signal)
      return selection.source === 'explicit'
        ? { ...chunk, meta: { ...chunk.meta, provider: `registered:${selection.provider}/${selection.model}` } }
        : chunk
    },
  }
}
