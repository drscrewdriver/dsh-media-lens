import { describe, expect, it } from 'vitest'
import { AllProvidersFailed, CooldownGate, runChain } from '../src/router/failover.ts'
import { ProviderRegistry, type LensRequest, type Provider } from '../src/router/registry.ts'
import { decideAudio, decideBudget, decideImage, decideVideo } from '../src/router/budget.ts'
import { makeChunk, type Attempt } from '../src/evidence.ts'

const MB = 1024 * 1024

function req(media: LensRequest['media'], overrides: Partial<LensRequest> = {}): LensRequest {
  return {
    path: 'x',
    sizeBytes: 1,
    media,
    budget: 'full',
    ...overrides,
  }
}

function fakeProvider(name: string, behavior: () => Promise<unknown>, remote = true, media: Provider['media'] = ['video', 'audio', 'image']): Provider {
  return {
    name,
    media,
    remote,
    available: () => true,
    run: behavior as Provider['run'],
  }
}

const okChunk = (provider: string) => makeChunk({
  kind: 'image',
  source: { path: 'x', sizeBytes: 1 },
  regions: [{ text: 'ok', kind: 'text' }],
  meta: { provider },
})

describe('failover（M4/M5/S3）', () => {
  it('fail → fail → ok：首个成功即返回，attempts 记录全部跳', async () => {
    const chain = [
      fakeProvider('a', async () => { throw new Error('a down') }),
      fakeProvider('b', async () => { throw new Error('b down') }),
      fakeProvider('c', async () => okChunk('c')),
    ]
    const evidence = await runChain(chain, req('image'), { now: (() => { let t = 0; return () => (t += 5) })() })
    expect(evidence.meta.provider).toBe('c')
    expect(evidence.meta.attempts).toHaveLength(3)
    expect(evidence.meta.attempts[0]).toMatchObject({ provider: 'a', ok: false })
    expect(evidence.meta.attempts[2]).toMatchObject({ provider: 'c', ok: true })
    expect(evidence.meta.attempts.every((a) => a.ms >= 0)).toBe(true)
    expect(evidence.meta.attempts.some((a) => a.ok && a.ms > 0)).toBe(true)
  })

  it('全败抛 AllProvidersFailed 且携带 attempts（M5）', async () => {
    const chain = [
      fakeProvider('a', async () => { throw new Error('a down') }),
      fakeProvider('b', async () => { throw new Error('b down') }),
    ]
    try {
      await runChain(chain, req('image'))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersFailed)
      const failure = err as AllProvidersFailed
      expect(failure.attempts).toHaveLength(2)
      expect(failure.attempts.every((a) => !a.ok)).toBe(true)
      expect(failure.message).toMatch(/image/)
    }
  })

  it('空链 → no provider configured（M9）', async () => {
    await expect(runChain([], req('video'))).rejects.toThrow(/no provider configured for video/)
  })
})

describe('冷却闸 v2（M21/M22：keyFailure-only + 垫队尾）', () => {
  it('typed keyFailure 一次即入冷却；resetAfterMs 优先于 cooldownMs', () => {
    let clock = 0
    const gate = new CooldownGate(100, () => clock)
    gate.recordFailure('a', { keyFailure: true })
    expect(gate.isOpen('a')).toBe(false)
    gate.recordSuccess('a')
    expect(gate.isOpen('a')).toBe(true)
    gate.recordFailure('a', { keyFailure: true, resetAfterMs: 50 })
    expect(gate.isOpen('a')).toBe(false)
    clock += 51
    expect(gate.isOpen('a')).toBe(true)
  })

  it('普通失败永不冷却——resetAfterMs 线索也不行（M21）', () => {
    let clock = 0
    const gate = new CooldownGate(100, () => clock)
    for (let i = 0; i < 10; i++) {
      gate.recordFailure('a', { keyFailure: false, resetAfterMs: 999 })
    }
    expect(gate.isOpen('a')).toBe(true)
    clock += 1000
    expect(gate.isOpen('a')).toBe(true)
  })

  it('冷却到期自动恢复（S4）', () => {
    let clock = 0
    const gate = new CooldownGate(50, () => clock)
    gate.recordFailure('p', { keyFailure: true })
    expect(gate.isOpen('p')).toBe(false)
    clock += 51
    expect(gate.isOpen('p')).toBe(true)
  })
})

describe('链级行为（M22 垫队尾 / 单成员原始错误 / keyIndex / warnings）', () => {
  it('冷却成员垫队尾仍被最后尝试（M22），warnings 记垫尾', async () => {
    const clock = 0
    const gate = new CooldownGate(100, () => clock)
    gate.recordFailure('a', { keyFailure: true })
    let bFailed = false
    const chain = [
      fakeProvider('a', async () => okChunk('a')),
      fakeProvider('b', async () => {
        if (!bFailed) {
          bFailed = true
          throw new Error('b transient')
        }
        return okChunk('b')
      }),
    ]
    const evidence = await runChain(chain, req('image'), { gate, now: () => clock })
    // a 在冷却中被垫到队尾：b 先试（失败一次），穷途时 a 仍被尝试并成功。
    expect(evidence.meta.provider).toBe('a')
    expect(evidence.meta.attempts.map((a) => a.provider)).toEqual(['b', 'a'])
    expect(evidence.meta.warnings?.some((w) => w.includes('a is cooling'))).toBe(true)
  })

  it('普通失败的 provider 不冷却：下一轮仍按原序先试（M21 端到端）', async () => {
    let calls = 0
    const chain = [
      fakeProvider('flaky', async () => {
        calls += 1
        if (calls === 1) throw new Error('transient network hiccup mentioning quota in body text')
        return okChunk('flaky')
      }),
      fakeProvider('backup', async () => okChunk('backup')),
    ]
    const first = await runChain(chain, req('image'))
    expect(first.meta.provider).toBe('backup')
    const second = await runChain(chain, req('image'))
    expect(second.meta.provider).toBe('flaky')
    expect(calls).toBe(2)
  })

  it('成功后 warnings 带 failover 摘要（M5/S11）', async () => {
    const chain = [
      fakeProvider('a', async () => { throw new Error('a down') }),
      fakeProvider('b', async () => okChunk('b')),
    ]
    const evidence = await runChain(chain, req('image'))
    expect(evidence.meta.warnings?.some((w) => w.includes('Failed over to b') && w.includes('a down'))).toBe(true)
  })

  it('单成员链穷尽保留原始可行动错误', async () => {
    const chain = [fakeProvider('solo', async () => { throw new Error('install ffmpeg or provide a smaller file') })]
    await expect(runChain(chain, req('image'))).rejects.toThrow(/install ffmpeg or provide a smaller file/)
  })

  it('轮换型失败（keyAttempts）并入 attempts 且带 keyIndex（M23）', async () => {
    const rotation = async (): Promise<never> => {
      const err = new Error('all keys exhausted') as Error & { keyAttempts?: Attempt[] }
      err.keyAttempts = [
        { provider: 'configured:openai', keyIndex: 0, ok: false, error: 'HTTP 401: bad key', ms: 5 },
        { provider: 'configured:openai', keyIndex: 1, ok: false, error: 'HTTP 429: quota', ms: 8 },
      ]
      throw err
    }
    const chain = [fakeProvider('configured:openai', rotation), fakeProvider('local:metadata', async () => okChunk('local'))]
    const evidence = await runChain(chain, req('image'))
    expect(evidence.meta.attempts.map((a) => a.keyIndex)).toEqual([0, 1, undefined])
    expect(evidence.meta.attempts[0]).toMatchObject({ provider: 'configured:openai', keyIndex: 0, ok: false })
  })

  it('成功跳透传 chunk.meta.keyIndex 进 attempts 并报轮换（M23）', async () => {
    const chunk = okChunk('configured:openai')
    const withKey = { ...chunk, meta: { ...chunk.meta, keyIndex: 2 } }
    const chain = [fakeProvider('configured:openai', async () => withKey)]
    const evidence = await runChain(chain, req('image'))
    expect(evidence.meta.attempts[0]).toMatchObject({ ok: true, keyIndex: 2 })
  })
})

describe('registry（M8）', () => {
  it('chainFor 按 media 过滤', () => {
    const registry = new ProviderRegistry()
    const imageOnly = fakeProvider('img', async () => okChunk('img'), true, ['image'])
    const audioOnly = fakeProvider('aud', async () => okChunk('aud'), true, ['audio'])
    registry.register(imageOnly)
    registry.register(audioOnly)
    expect(registry.chainFor('image', false).map((p) => p.name)).toEqual(['img'])
    expect(registry.chainFor('audio', false).map((p) => p.name)).toEqual(['aud'])
  })

  it('strictLocalOnly 剔除远端成员（M8）', () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider('remote-vl', async () => okChunk('remote-vl'), true))
    registry.register(fakeProvider('local-asr', async () => okChunk('local-asr'), false))
    expect(registry.chainFor('image', true).map((p) => p.name)).toEqual(['local-asr'])
    expect(registry.chainFor('image', false).map((p) => p.name)).toEqual(['remote-vl', 'local-asr'])
  })

  it('available()=false 的成员不进链', () => {
    const registry = new ProviderRegistry()
    const down = fakeProvider('down', async () => okChunk('down'))
    down.available = () => false
    registry.register(down)
    registry.register(fakeProvider('up', async () => okChunk('up')))
    expect(registry.chainFor('image', false).map((p) => p.name)).toEqual(['up'])
  })
})

describe('预算裁决（M7/S5）', () => {
  it('视频 ≤10MB → full；10–19MB → reencode；>19MB → sampleFrames', () => {
    expect(decideVideo(9 * MB, 60)).toBe('full')
    expect(decideVideo(15 * MB, 60)).toBe('reencode')
    expect(decideVideo(20 * MB, 60)).toBe('sampleFrames')
  })

  it('视频 >10min → sampleFrames（时长优先）', () => {
    expect(decideVideo(5 * MB, 601)).toBe('sampleFrames')
    expect(decideVideo(5 * MB, 600)).toBe('full')
  })

  it('音频时长不可探测或超单段上限 → segment', () => {
    expect(decideAudio(undefined)).toBe('segment')
    expect(decideAudio(1801)).toBe('segment')
    expect(decideAudio(1800)).toBe('full')
  })

  it('图片超软上限 → downsample', () => {
    expect(decideImage(9 * MB)).toBe('downsample')
    expect(decideImage(1 * MB)).toBe('full')
  })

  it('decideBudget 分派（M7 断言 >19MB 不硬拒而是降级）', () => {
    expect(decideBudget('video', 25 * MB, undefined)).toBe('sampleFrames')
    expect(decideBudget('audio', 1, undefined)).toBe('segment')
    expect(decideBudget('image', 100, undefined)).toBe('full')
  })
})
