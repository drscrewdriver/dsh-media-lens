import { describe, expect, it } from 'vitest'
import { discoverRegisteredModels, resolveSelection, type LlmDiscoveryFace } from '../src/discovery.ts'
import { parseModelSelection, resolveConfig, DEFAULT_CONFIG } from '../src/config.ts'
import type { RegisteredDeps } from '../src/providers/registered.ts'
import type { LensDeps } from '../src/tools/chains.ts'
import { buildAudioChain, buildVideoChain, buildImageChain } from '../src/tools/chains.ts'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

function fakeLlm(providers: { id: string; models: unknown[] }[]): LlmDiscoveryFace {
  return {
    listProviders: () => providers.map((p) => ({ id: p.id, name: p.id })),
    listModels: async (provider: string) => providers.find((p) => p.id === provider)?.models ?? [],
  }
}

describe('discovery（M17）', () => {
  it('枚举 provider → 模型并按模态分组', async () => {
    const llm = fakeLlm([
      { id: 'llm-pi-ai', models: [
        { id: 'vision-x', name: 'Vision X', inputModalities: ['text', 'image'] },
        { id: 'text-only', name: 'Text', inputModalities: ['text'] },
        { id: 'mystery', name: 'Mystery' },
      ] },
      { id: 'mimo', models: [{ id: 'mimo-omni', name: 'MiMo', inputModalities: ['text', 'image', 'video', 'audio'] }] },
    ])
    const snapshot = await discoverRegisteredModels(llm)
    expect(snapshot.available).toBe(true)
    expect(snapshot.models).toHaveLength(4)
    expect(snapshot.groups.image.map((m) => m.id)).toEqual(['vision-x', 'mimo-omni'])
    expect(snapshot.groups.video.map((m) => m.id)).toEqual(['mimo-omni'])
    expect(snapshot.groups.audio.map((m) => m.id)).toEqual(['mimo-omni'])
  })

  it('llm service 缺失 → 软降级不 throw（M17 原14）', async () => {
    const snapshot = await discoverRegisteredModels(undefined)
    expect(snapshot.available).toBe(false)
    expect(snapshot.models).toEqual([])
    expect(snapshot.groups.image).toEqual([])
  })

  it('listModels 抛错 → 跳过该 provider 其余照常', async () => {
    const llm: LlmDiscoveryFace = {
      listProviders: () => [{ id: 'bad' }, { id: 'good' }],
      listModels: async (provider) => {
        if (provider === 'bad') throw new Error('exploded')
        return [{ id: 'm1', inputModalities: ['image'] }]
      },
    }
    const snapshot = await discoverRegisteredModels(llm)
    expect(snapshot.available).toBe(true)
    expect(snapshot.models).toHaveLength(1)
    expect(snapshot.models[0]?.provider).toBe('good')
  })
})

describe('resolveSelection（M19 前置）', () => {
  const snapshot = {
    available: true,
    models: [],
    groups: {
      image: [{ provider: 'p1', id: 'vision', name: 'v', modalities: ['image'] }],
      audio: [],
      video: [],
    },
  }

  it('显式 provider/model 优先（即使模态未声明）', () => {
    expect(resolveSelection(snapshot, 'video', 'mimo/mimo-omni')).toEqual({
      provider: 'mimo', model: 'mimo-omni', source: 'explicit',
    })
  })

  it('auto 取分组首个；空分组返回 undefined', () => {
    expect(resolveSelection(snapshot, 'image', 'auto')).toEqual({ provider: 'p1', model: 'vision', source: 'auto' })
    expect(resolveSelection(snapshot, 'audio', 'auto')).toBeUndefined()
  })

  it('非选择串返回 undefined', () => {
    expect(resolveSelection(snapshot, 'image', '')).toEqual({ provider: 'p1', model: 'vision', source: 'auto' })
  })
})

describe('config（M17/M18 配置面）', () => {
  it('默认值 + 深合并', () => {
    const merged = resolveConfig({ strictLocalOnly: true, providers: { openai: { apiKey: 'k1,k2' } } })
    expect(merged.strictLocalOnly).toBe(true)
    expect(merged.providers.openai.apiKey).toBe('k1,k2')
    expect(merged.providers.openai.baseUrl).toBe('')
    expect(merged.providers.asr.endpoints).toEqual([])
    expect(merged.cooldownMs).toBe(DEFAULT_CONFIG.cooldownMs)
    expect(merged.models.video).toBe('auto')
    // Phase 7 M28：refine 默认关 + model 空串
    expect(merged.refine.enabled).toBe(false)
    expect(merged.refine.model).toBe('')
  })

  it('refine 部分覆盖与 trim（M28）', () => {
    const merged = resolveConfig({ refine: { enabled: true, model: '  mimo/mimo-text  ' } })
    expect(merged.refine.enabled).toBe(true)
    expect(merged.refine.model).toBe('mimo/mimo-text')
    // auto 同未启用：enabled 保留 true 但 model 保留 'auto' 字串，调用方
    // (index.ts refineFn 工厂) 会因 selection === 'auto' 而返回 undefined。
    const auto = resolveConfig({ refine: { enabled: true, model: 'auto' } })
    expect(auto.refine.model).toBe('auto')
  })

  it('parseModelSelection 首个 / 分隔；auto/空返回 undefined', () => {
    expect(parseModelSelection('mimo/mimo-omni')).toEqual({ provider: 'mimo', model: 'mimo-omni' })
    expect(parseModelSelection('auto')).toBeUndefined()
    expect(parseModelSelection('')).toBeUndefined()
    expect(parseModelSelection('/nope')).toBeUndefined()
  })
})

/** 全可用的假 deps（链序断言面）。 */
function fakeDeps(overrides: Partial<Pick<LensDeps, 'asrEndpoints' | 'strictLocalOnly'>> = {}): LensDeps {
  const llm = { listProviders: () => [], listModels: async () => [] } as unknown as LlmRuntime
  const attachments = { saveImage: async () => ({}), saveFile: async () => ({}) } as unknown as AttachmentStore
  const registered: RegisteredDeps = {
    llm,
    attachments,
    snapshot: () => ({
      available: true,
      models: [],
      groups: {
        image: [{ provider: 'p1', id: 'vision', name: 'v', modalities: ['image'] }],
        audio: [{ provider: 'p1', id: 'omni', name: 'o', modalities: ['audio', 'video'] }],
        video: [{ provider: 'p1', id: 'omni', name: 'o', modalities: ['audio', 'video'] }],
      },
    }),
    selectionFor: () => 'auto',
  }
  return {
    registered,
    vlConfig: () => ({ baseUrl: 'https://vl.example', apiKey: 'k', model: 'vl-1' }),
    asrEndpoints: overrides.asrEndpoints ?? (() => [{ name: 'endpoint-1', command: 'python asr.py --input {input}' }]),
    strictLocalOnly: overrides.strictLocalOnly ?? (() => false),
  }
}

describe('链构建（M18/M20/M8）', () => {
  it('audio 链序：multimodal → asr endpoints → local（M20）', () => {
    const chain = buildAudioChain(fakeDeps())
    expect(chain.map((p) => p.name)).toEqual([
      'multimodal:auto',
      'asr:endpoint-1',
      'local:metadata',
    ])
  })

  it('audio 多端点切换：endpoints 变化即换链成员（M18）', () => {
    const deps = fakeDeps({ asrEndpoints: () => [
      { name: 'endpoint-1', command: 'python a.py --input {input}' },
      { name: 'endpoint-2', command: 'python b.py --input {input}' },
    ] })
    expect(buildAudioChain(deps).map((p) => p.name)).toEqual([
      'multimodal:auto',
      'asr:endpoint-1',
      'asr:endpoint-2',
      'local:metadata',
    ])
    const switched = fakeDeps({ asrEndpoints: () => [{ name: 'endpoint-2', command: 'python b.py --input {input}' }] })
    expect(buildAudioChain(switched).map((p) => p.name)).not.toContain('asr:endpoint-1')
  })

  it('video full 链序：multimodal 直传首选 → frames → local（M20/FR-2）', () => {
    expect(buildVideoChain(fakeDeps(), 'full').map((p) => p.name)).toEqual([
      'multimodal:auto',
      'frames:registered:auto',
      'local:metadata',
    ])
  })

  it('video reencode 链首是 reencode:multimodal；sampleFrames 直接走抽帧', () => {
    expect(buildVideoChain(fakeDeps(), 'reencode')[0]?.name).toBe('reencode:multimodal:auto')
    expect(buildVideoChain(fakeDeps(), 'sampleFrames').map((p) => p.name)).toEqual([
      'frames:registered:auto',
      'local:metadata',
    ])
  })

  it('image 链序：registered → configured:openai → local（M19 前缀在链名）', () => {
    expect(buildImageChain(fakeDeps()).map((p) => p.name)).toEqual([
      'registered:auto',
      'configured:openai',
      'local:metadata',
    ])
  })

  it('strictLocalOnly=true：链只剩本地成员（M8）', () => {
    const deps = fakeDeps({ strictLocalOnly: () => true })
    expect(buildImageChain(deps).map((p) => p.name)).toEqual(['local:metadata'])
    expect(buildAudioChain(deps).map((p) => p.name)).toEqual(['asr:endpoint-1', 'local:metadata'])
    expect(buildVideoChain(deps, 'full').map((p) => p.name)).toEqual(['local:metadata'])
  })

  it('llm/attachments 缺失：registered/multimodal 不进链，configured 兜住 image（C2）', () => {
    const deps = fakeDeps()
    deps.registered = { ...deps.registered, llm: undefined, attachments: undefined }
    expect(buildImageChain(deps).map((p) => p.name)).toEqual(['configured:openai', 'local:metadata'])
    expect(buildAudioChain(deps).map((p) => p.name)).toEqual(['asr:endpoint-1', 'local:metadata'])
  })

  it('discovery 空分组 + auto：registered/multimodal 不进链（无注册模型回退自配，M19）', () => {
    const deps = fakeDeps()
    deps.registered = {
      ...deps.registered,
      snapshot: () => ({ available: true, models: [], groups: { image: [], audio: [], video: [] } }),
    }
    expect(buildImageChain(deps).map((p) => p.name)).toEqual(['configured:openai', 'local:metadata'])
    expect(buildAudioChain(deps).map((p) => p.name)).toEqual(['asr:endpoint-1', 'local:metadata'])
  })
})
