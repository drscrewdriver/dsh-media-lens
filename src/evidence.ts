/**
 * 证据合同（FR-1）：透镜输出 = 路由输出，三媒体共用一份 schema。
 * 所有 provider 产出 Chunk（单跳证据 + 单跳 meta），failover 聚合为
 * MediaEvidence 并追加 attempts —— 降级绝不静默（meta.attempts 必带）。
 */

export type MediaKind = 'video' | 'audio' | 'image'

export interface Attempt {
  provider: string
  ok: boolean
  /** 多 key 轮换时的零基 key 序号（FR-11：轮换过程证据可见）。 */
  keyIndex?: number
  error?: string
  ms: number
}

export interface MediaEvidence {
  kind: MediaKind
  source: {
    path: string
    sizeBytes: number
    durationSec?: number
    resolution?: [number, number]
  }
  /** video：场景时间线（抽帧路逐帧一条；直传路由模型自行给 t）。 */
  timeline?: { t: number; text: string }[]
  /** audio/video：语音转写（时间戳 + 可选说话人）。 */
  transcript?: { t0: number; t1: number; speaker?: string; text: string }[]
  /** image：版面区域 / 实体列表。 */
  regions?: { bbox?: [number, number, number, number]; text: string; kind: string }[]
  /** 模型自报读不清/含糊处（FR-12：宁标不猜）。 */
  uncertainty?: string[]
  meta: {
    provider: string
    attempts: Attempt[]
    generatedAt: string
    degraded?: string
    /** 人类可读路由通告（FR-11：failover 去向、冷却垫尾、轮换成功）。 */
    warnings?: string[]
    /**
     * Phase 7（FR-19）：链出口 refine pass 的独立归属位——不并入 attempts（主链
     * 语义干净）；refine 成功或失败均落该字段，`provider = 'refined:<selection>'`
     * 或失败时的读手 provider 原名 + `ok:false`；未启用 refine 时保持 undefined。
     */
    refineAttempt?: Attempt
  }
}

/** provider 单跳产出：证据本体 + 单跳 meta；attempts 由 failover 统一追加。 */
export type Chunk = Omit<MediaEvidence, 'meta'> & {
  meta: {
    provider: string
    generatedAt: string
    degraded?: string
    /** 成功跳使用的 key 序号（多 key 轮换）；finalize 时落到 attempts，不进证据 meta。 */
    keyIndex?: number
  }
}

export function makeChunk(
  base: Omit<Chunk, 'meta' | 'generatedAt'> & { meta: { provider: string; degraded?: string; keyIndex?: number } },
): Chunk {
  return {
    kind: base.kind,
    source: base.source,
    ...(base.timeline !== undefined ? { timeline: base.timeline } : {}),
    ...(base.transcript !== undefined ? { transcript: base.transcript } : {}),
    ...(base.regions !== undefined ? { regions: base.regions } : {}),
    ...(base.uncertainty !== undefined ? { uncertainty: base.uncertainty } : {}),
    meta: {
      provider: base.meta.provider,
      generatedAt: new Date().toISOString(),
      ...(base.meta.degraded !== undefined ? { degraded: base.meta.degraded } : {}),
      ...(base.meta.keyIndex !== undefined ? { keyIndex: base.meta.keyIndex } : {}),
    },
  }
}

/** Chunk → MediaEvidence：叠加 failover 聚合的 attempts/warnings（首个成功即定稿）。 */
export function finalizeChunk(chunk: Chunk, attempts: Attempt[], warnings?: string[]): MediaEvidence {
  return {
    kind: chunk.kind,
    source: chunk.source,
    ...(chunk.timeline !== undefined ? { timeline: chunk.timeline } : {}),
    ...(chunk.transcript !== undefined ? { transcript: chunk.transcript } : {}),
    ...(chunk.regions !== undefined ? { regions: chunk.regions } : {}),
    ...(chunk.uncertainty !== undefined ? { uncertainty: chunk.uncertainty } : {}),
    meta: {
      provider: chunk.meta.provider,
      attempts,
      generatedAt: chunk.meta.generatedAt,
      ...(chunk.meta.degraded !== undefined ? { degraded: chunk.meta.degraded } : {}),
      ...(warnings !== undefined && warnings.length > 0 ? { warnings } : {}),
    },
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 校验 MediaEvidence 结构（M1）：合法返回 null，否则返回人类可读错误串。
 * 只做结构与有限性检查，不做语义检查（空 timeline 等由调用方裁量）。
 */
export function validateEvidence(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'evidence: not an object'
  const v = value as Record<string, unknown>
  if (v['kind'] !== 'video' && v['kind'] !== 'audio' && v['kind'] !== 'image') {
    return 'evidence.kind: must be video | audio | image'
  }
  const source = v['source']
  if (typeof source !== 'object' || source === null) return 'evidence.source: missing'
  const s = source as Record<string, unknown>
  if (typeof s['path'] !== 'string' || s['path'] === '') return 'evidence.source.path: must be a non-empty string'
  if (!isFiniteNumber(s['sizeBytes']) || (s['sizeBytes'] as number) < 0) {
    return 'evidence.source.sizeBytes: must be a finite number ≥ 0'
  }
  if (s['durationSec'] !== undefined && !isFiniteNumber(s['durationSec'])) {
    return 'evidence.source.durationSec: must be a finite number'
  }
  const resolution = s['resolution']
  if (resolution !== undefined) {
    if (!Array.isArray(resolution) || resolution.length !== 2 || !resolution.every(isFiniteNumber)) {
      return 'evidence.source.resolution: must be [width, height]'
    }
  }
  const meta = v['meta']
  if (typeof meta !== 'object' || meta === null) return 'evidence.meta: missing'
  const m = meta as Record<string, unknown>
  if (typeof m['provider'] !== 'string' || m['provider'] === '') return 'evidence.meta.provider: must be a non-empty string'
  if (!Array.isArray(m['attempts'])) return 'evidence.meta.attempts: must be an array'
  for (const attempt of m['attempts'] as unknown[]) {
    if (typeof attempt !== 'object' || attempt === null) return 'evidence.meta.attempts[]: not an object'
    const a = attempt as Record<string, unknown>
    if (typeof a['provider'] !== 'string' || a['provider'] === '') return 'evidence.meta.attempts[].provider: must be a non-empty string'
    if (typeof a['ok'] !== 'boolean') return 'evidence.meta.attempts[].ok: must be a boolean'
    if (!isFiniteNumber(a['ms']) || (a['ms'] as number) < 0) return 'evidence.meta.attempts[].ms: must be a finite number ≥ 0'
    if (a['error'] !== undefined && typeof a['error'] !== 'string') return 'evidence.meta.attempts[].error: must be a string'
    if (a['keyIndex'] !== undefined && (!isFiniteNumber(a['keyIndex']) || (a['keyIndex'] as number) < 0)) return 'evidence.meta.attempts[].keyIndex: must be a number ≥ 0'
  }
  if (m['generatedAt'] !== undefined && typeof m['generatedAt'] !== 'string') return 'evidence.meta.generatedAt: must be a string'
  if (m['degraded'] !== undefined && typeof m['degraded'] !== 'string') return 'evidence.meta.degraded: must be a string'
  const warnings = m['warnings']
  if (warnings !== undefined) {
    if (!Array.isArray(warnings) || !warnings.every((w) => typeof w === 'string')) return 'evidence.meta.warnings: must be an array of strings'
  }
  const refineAttempt = m['refineAttempt']
  if (refineAttempt !== undefined) {
    if (typeof refineAttempt !== 'object' || refineAttempt === null) return 'evidence.meta.refineAttempt: must be an object'
    const a = refineAttempt as Record<string, unknown>
    if (typeof a['provider'] !== 'string' || a['provider'] === '') return 'evidence.meta.refineAttempt.provider: must be a non-empty string'
    if (typeof a['ok'] !== 'boolean') return 'evidence.meta.refineAttempt.ok: must be a boolean'
    if (!isFiniteNumber(a['ms']) || (a['ms'] as number) < 0) return 'evidence.meta.refineAttempt.ms: must be a finite number ≥ 0'
    if (a['error'] !== undefined && typeof a['error'] !== 'string') return 'evidence.meta.refineAttempt.error: must be a string'
  }
  const uncertainty = v['uncertainty']
  if (uncertainty !== undefined) {
    if (!Array.isArray(uncertainty) || !uncertainty.every((u) => typeof u === 'string')) return 'evidence.uncertainty: must be an array of strings'
  }

  const timeline = v['timeline']
  if (timeline !== undefined) {
    if (!Array.isArray(timeline)) return 'evidence.timeline: must be an array'
    for (const entry of timeline) {
      if (typeof entry !== 'object' || entry === null) return 'evidence.timeline[]: not an object'
      const e = entry as Record<string, unknown>
      if (!isFiniteNumber(e['t'])) return 'evidence.timeline[].t: must be a finite number'
      if (typeof e['text'] !== 'string') return 'evidence.timeline[].text: must be a string'
    }
  }
  const transcript = v['transcript']
  if (transcript !== undefined) {
    if (!Array.isArray(transcript)) return 'evidence.transcript: must be an array'
    for (const entry of transcript) {
      if (typeof entry !== 'object' || entry === null) return 'evidence.transcript[]: not an object'
      const e = entry as Record<string, unknown>
      if (!isFiniteNumber(e['t0']) || !isFiniteNumber(e['t1'])) return 'evidence.transcript[].t0/t1: must be finite numbers'
      if ((e['t0'] as number) > (e['t1'] as number)) return 'evidence.transcript[]: t0 must be ≤ t1'
      if (e['speaker'] !== undefined && typeof e['speaker'] !== 'string') return 'evidence.transcript[].speaker: must be a string'
      if (typeof e['text'] !== 'string') return 'evidence.transcript[].text: must be a string'
    }
  }
  const regions = v['regions']
  if (regions !== undefined) {
    if (!Array.isArray(regions)) return 'evidence.regions: must be an array'
    for (const entry of regions) {
      if (typeof entry !== 'object' || entry === null) return 'evidence.regions[]: not an object'
      const e = entry as Record<string, unknown>
      if (typeof e['text'] !== 'string') return 'evidence.regions[].text: must be a string'
      if (typeof e['kind'] !== 'string') return 'evidence.regions[].kind: must be a string'
      if (e['bbox'] !== undefined) {
        if (!Array.isArray(e['bbox']) || (e['bbox'] as unknown[]).length !== 4 || !(e['bbox'] as unknown[]).every(isFiniteNumber)) {
          return 'evidence.regions[].bbox: must be [x, y, w, h]'
        }
      }
    }
  }
  return null
}

/** JSON 序列化（S6）：合同内的结构都是 JSON 值，UTF-8 安全由调用方传输层保证。 */
export function serializeEvidence(evidence: MediaEvidence): string {
  return JSON.stringify(evidence)
}

/** 从 JSON 文本恢复并校验；非法输入返回 undefined（不 throw，调用方自行报错）。 */
export function deserializeEvidence(text: string): MediaEvidence | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return validateEvidence(parsed) === null ? (parsed as MediaEvidence) : undefined
  } catch {
    return undefined
  }
}

/**
 * MediaEvidence → 工具 execute 的 JSON 返回值：合同内结构按构造即 JSON 安全，
 * 这里仅做类型面转换（接口无隐式索引签名，无法直接赋 JsonValue）。
 */
export function asJsonValue(evidence: MediaEvidence): unknown {
  return evidence
}
