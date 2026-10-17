import { describe, expect, it } from 'vitest'
import {
  deserializeEvidence,
  finalizeChunk,
  makeChunk,
  serializeEvidence,
  validateEvidence,
  type MediaEvidence,
} from '../src/evidence.ts'

const base = {
  kind: 'image' as const,
  source: { path: 'C:\\media\\pic.png', sizeBytes: 1234 },
  regions: [{ text: 'Total: 42', kind: 'text', bbox: [0, 0, 100, 20] as [number, number, number, number] }],
  meta: { provider: 'configured:openai', attempts: [{ provider: 'configured:openai', ok: true, ms: 120 }], generatedAt: '2026-10-06T00:00:00.000Z' },
}

describe('validateEvidence 正例（M1）', () => {
  it('image 完整证据', () => {
    expect(validateEvidence(base)).toBeNull()
  })

  it('video timeline + transcript 证据', () => {
    const video: MediaEvidence = {
      kind: 'video',
      source: { path: 'a.mp4', sizeBytes: 1, durationSec: 30, resolution: [1920, 1080] },
      timeline: [{ t: 0, text: 'title card' }],
      transcript: [{ t0: 1, t1: 2.5, speaker: 'alice', text: 'hello' }],
      meta: { provider: 'multimodal:p/x', attempts: [], generatedAt: '2026-10-06T00:00:00.000Z' },
    }
    expect(validateEvidence(video)).toBeNull()
  })

  it('audio transcript 证据', () => {
    const audio: MediaEvidence = {
      kind: 'audio',
      source: { path: 'a.wav', sizeBytes: 9 },
      transcript: [{ t0: 0, t1: 1, text: 'hi' }],
      meta: { provider: 'asr:endpoint-1', attempts: [{ provider: 'asr:endpoint-1', ok: true, ms: 5 }], generatedAt: 'x', degraded: 'segment-budget' },
    }
    expect(validateEvidence(audio)).toBeNull()
  })

  it('uncertainty + warnings + keyIndex（合同 v2）', () => {
    const evidence: MediaEvidence = {
      kind: 'image',
      source: { path: 'p', sizeBytes: 1 },
      regions: [{ text: 't', kind: 'k' }],
      uncertainty: ['bottom-left unreadable'],
      meta: {
        provider: 'configured:openai',
        attempts: [
          { provider: 'configured:openai', keyIndex: 0, ok: false, error: 'HTTP 401', ms: 3 },
          { provider: 'configured:openai', keyIndex: 1, ok: true, ms: 9 },
        ],
        generatedAt: 'g',
        warnings: ['Failed over to key 2.'],
      },
    }
    expect(validateEvidence(evidence)).toBeNull()
    expect(validateEvidence({ ...evidence, uncertainty: 'not-an-array' })).toMatch(/uncertainty/)
    expect(validateEvidence({ ...evidence, meta: { ...evidence.meta, warnings: [42] } })).toMatch(/warnings/)
    expect(validateEvidence({
      ...evidence,
      meta: { ...evidence.meta, attempts: [{ provider: 'x', ok: true, keyIndex: -1, ms: 1 }] },
    })).toMatch(/keyIndex/)
  })
})

describe('validateEvidence 反例（M1/M2）', () => {
  it('缺 meta.attempts 拒绝', () => {
    const bad = { ...base, meta: { provider: 'x', generatedAt: 'y' } }
    expect(validateEvidence(bad)).toMatch(/attempts/)
  })

  it('kind 非法拒绝', () => {
    expect(validateEvidence({ ...base, kind: 'document' })).toMatch(/kind/)
  })

  it('source.sizeBytes 缺失拒绝', () => {
    expect(validateEvidence({ ...base, source: { path: 'p' } })).toMatch(/sizeBytes/)
  })

  it('transcript t0 > t1 拒绝（时间戳规整）', () => {
    expect(validateEvidence({
      kind: 'audio',
      source: { path: 'a', sizeBytes: 1 },
      transcript: [{ t0: 5, t1: 1, text: 'x' }],
      meta: { provider: 'p', attempts: [], generatedAt: 'g' },
    })).toMatch(/t0/)
  })
})

describe('序列化往返（S6）', () => {
  it('JSON 往返无损', () => {
    const text = serializeEvidence(base)
    const restored = deserializeEvidence(text)
    expect(restored).not.toBeUndefined()
    expect(restored).toEqual(base)
  })

  it('含 uncertainty/warnings 的证据往返无损（S10）', () => {
    const withNew: MediaEvidence = {
      ...base,
      uncertainty: ['blurry corner'],
      meta: { ...base.meta, warnings: ['Failed over to configured:openai.'] },
    }
    expect(deserializeEvidence(serializeEvidence(withNew))).toEqual(withNew)
  })

  it('非法 JSON 返回 undefined 而非 throw', () => {
    expect(deserializeEvidence('{not json')).toBeUndefined()
    expect(deserializeEvidence('{"kind":"nope"}')).toBeUndefined()
  })
})

describe('Chunk → MediaEvidence 聚合', () => {
  it('finalizeChunk 叠加 attempts 并保留单跳 meta（M2）', () => {
    const chunk = makeChunk({
      kind: 'audio',
      source: { path: 'a', sizeBytes: 3 },
      transcript: [{ t0: 0, t1: 1, text: 'x' }],
      meta: { provider: 'asr:e1', degraded: 'segment-budget' },
    })
    const evidence = finalizeChunk(chunk, [
      { provider: 'multimodal:p/m', ok: false, error: 'boom', ms: 12 },
      { provider: 'asr:e1', ok: true, ms: 40 },
    ])
    expect(evidence.meta.attempts).toHaveLength(2)
    expect(evidence.meta.attempts[0]).toMatchObject({ ok: false, provider: 'multimodal:p/m' })
    expect(evidence.meta.provider).toBe('asr:e1')
    expect(evidence.meta.degraded).toBe('segment-budget')
    expect(validateEvidence(evidence)).toBeNull()
  })
})
