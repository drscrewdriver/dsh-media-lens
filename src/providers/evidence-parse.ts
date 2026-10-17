/**
 * 模型文本 → 证据结构 的解析层（registered / multimodal / openai-vl 共用）。
 *
 * 纪律：
 * - 图片：解析失败可用裸文本降级（VL 的 prose 描述仍有引用价值）。
 * - 视频/音频直传：必须解析出结构化证据且内容有实质（否则模型很可能只看到
 *   handle 文本而非真媒体），一律 throw 让链落到抽帧/ASR 兜底 —— 宁可降级，
 *   不产幻觉证据。
 */

import type { Chunk, MediaKind } from '../evidence.ts'
import { validateEvidence } from '../evidence.ts'

/** 模型回复里常见的证据 JSON 包裹物。 */
export function extractJsonBlock(text: string): unknown | undefined {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates: string[] = []
  if (fenced?.[1] !== undefined) candidates.push(fenced[1])
  candidates.push(trimmed)
  const firstBrace = trimmed.indexOf('{')
  const firstBracket = trimmed.indexOf('[')
  const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket)
  if (start !== -1) {
    const lastBrace = trimmed.lastIndexOf('}')
    const lastBracket = trimmed.lastIndexOf(']')
    const end = Math.max(lastBrace, lastBracket)
    if (end > start) candidates.push(trimmed.slice(start, end + 1))
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // 试下一个候选
    }
  }
  return undefined
}

const MIN_TEXT_LENGTH = 8

/**
 * null 归一（FR-12，modlens issue #37 教训）：可选字段的 null 与缺省同义，
 * 先删再验而不是拒整读。顶层可选数组 + regions[].bbox 两处。
 */
export function stripOptionalNulls(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...body }
  for (const key of ['timeline', 'transcript', 'regions', 'uncertainty'] as const) {
    if (cleaned[key] === null || cleaned[key] === undefined) delete cleaned[key]
  }
  if (Array.isArray(cleaned['regions'])) {
    cleaned['regions'] = (cleaned['regions'] as unknown[]).map((region) => {
      if (typeof region !== 'object' || region === null) return region
      const entry = { ...(region as Record<string, unknown>) }
      if (entry['bbox'] === null || entry['bbox'] === undefined) delete entry['bbox']
      return entry
    })
  }
  return cleaned
}

/**
 * 把模型的 JSON 回复映射成 Chunk。
 * 接受完整 MediaEvidence 形状（补 meta）或纯载荷形状（timeline/transcript/regions/uncertainty）。
 */
export function evidenceFromModelJson(
  parsed: unknown,
  media: MediaKind,
  source: Chunk['source'],
  providerName: string,
): Chunk | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const body = stripOptionalNulls(parsed as Record<string, unknown>)
  const candidate: Record<string, unknown> = {
    kind: typeof body['kind'] === 'string' ? body['kind'] : media,
    source: (typeof body['source'] === 'object' && body['source'] !== null ? body['source'] : source),
    meta: {
      provider: providerName,
      attempts: [],
      generatedAt: new Date().toISOString(),
      ...(typeof body['degraded'] === 'string' ? { degraded: body['degraded'] } : {}),
    },
  }
  for (const key of ['timeline', 'transcript', 'regions', 'uncertainty'] as const) {
    if (body[key] !== undefined) candidate[key] = body[key]
  }
  if (validateEvidence(candidate) !== null) return undefined
  const meta = candidate['meta'] as { provider: string; attempts: never[]; generatedAt: string }
  const chunk: Chunk = {
    kind: candidate['kind'] as MediaKind,
    source: candidate['source'] as Chunk['source'],
    ...(candidate['timeline'] !== undefined ? { timeline: candidate['timeline'] as Chunk['timeline'] } : {}),
    ...(candidate['transcript'] !== undefined ? { transcript: candidate['transcript'] as Chunk['transcript'] } : {}),
    ...(candidate['regions'] !== undefined ? { regions: candidate['regions'] as Chunk['regions'] } : {}),
    ...(candidate['uncertainty'] !== undefined ? { uncertainty: candidate['uncertainty'] as string[] } : {}),
    meta: { provider: meta.provider, generatedAt: meta.generatedAt },
  }
  return chunk
}

/** 直传回执是否有实质内容（防 handle 文本回声）。 */
export function hasSubstantiveText(text: string): boolean {
  return text.trim().length >= MIN_TEXT_LENGTH
}
