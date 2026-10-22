/**
 * vision-bridge（v4）测试：包装判据真值表 / handle 识别 / 消息改写（copy-on-write +
 * replay 回标 + 图像透传分流）/ 证据缓存 / sweep 注册与回收 / 桥端到端（读手 → 证据
 * 文本 → 委托上游）/ 失败常量占位 / discovery 自排除。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EMPTY_SNAPSHOT, filterDiscoverySnapshot } from '../src/discovery.ts'
import { resolveConfig } from '../src/config.ts'
import type { MediaEvidence } from '../src/evidence.ts'
import {
  BRIDGE_FAILURES,
  EvidenceMemo,
  OWN_PROVIDER_PREFIX,
  createVisionBridge,
  evidenceBridgeText,
  fileHandlePath,
  rewriteMessages,
  shouldWrapModel,
  VISION_MODEL_SUFFIX,
} from '../src/inject.ts'
import type { LensDeps } from '../src/tools/chains.ts'

const FAMILIES = ['deepseek', 'glm', 'mimo']

describe('shouldWrapModel（包装判据）', () => {
  const wrap = (id: string, extra: Record<string, unknown> = {}): boolean =>
    shouldWrapModel({ id, name: id, ...extra }, FAMILIES)

  it('纯文本模型按 family 前缀包装', () => {
    expect(wrap('deepseek-v4.1')).toBe(true)
    expect(wrap('deepseek-official/deepseek-v4.1')).toBe(true)
    expect(wrap('glm-5-air')).toBe(true)
  })

  it('families 之外不包装；* 放行', () => {
    expect(wrap('openai/gpt-5')).toBe(false)
    expect(shouldWrapModel({ id: 'openai/gpt-5', name: 'gpt-5' }, ['*'])).toBe(true)
  })

  it('omni 宽模态拒包：mimo bare 非 -pro 段（用户裁定）', () => {
    expect(wrap('mimo/mimo-v2.6-flash')).toBe(false)
    expect(wrap('mimo-v2.6-flash')).toBe(false)
    expect(wrap('mimo/mimo-v3-pro')).toBe(true)
  })

  it('vision 专精词表拒包', () => {
    expect(wrap('deepseek-vl-2')).toBe(false)
    expect(wrap('glm-4v-flash')).toBe(false)
    expect(wrap('qwen2-vision-7b', { id: 'some/qwen2-vision-7b' })).toBe(false)
    expect(wrap('glm-5.3-flash')).toBe(false)
  })

  it('声明 image 不是否决项（图像模型包进去补音视频）', () => {
    expect(wrap('glm-5-air', { inputModalities: ['text', 'image'] })).toBe(true)
  })

  it('id 缺失不包装', () => {
    expect(shouldWrapModel({}, FAMILIES)).toBe(false)
  })
})

describe('fileHandlePath（宿主 handle 文本识别）', () => {
  it('精确解析 content.ts fileHandleText 格式的只读路径', () => {
    // 宿主 quoted() = JSON.stringify：盘上路径里的反斜杠在文本中是转义形态。
    const text = '[File "clip.mp4" (1048576 bytes, sha256:deadbeef): verbatim read-only copy saved at "E:\\\\media\\\\clip.mp4". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]'
    expect(fileHandlePath(text)).toBe('E:\\media\\clip.mp4')
  })

  it('无路径形态与普通文本返回 undefined', () => {
    expect(fileHandlePath('[File "x.bin" (5 bytes, sha256:deadbeef) was uploaded, but the current execution environment cannot access a readable path.]')).toBeUndefined()
    expect(fileHandlePath('just some text')).toBeUndefined()
  })
})

describe('rewriteMessages（copy-on-write 改写 + 回标）', () => {
  const frozen = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  it('rewriteImage=true：图像块与 handle 文本替换，未涉消息保持同一引用', async () => {
    const untouched = frozen({ role: 'system', content: [{ type: 'text', text: 'sys' }] })
    const handleText = '[File "a.mp4" (10 bytes, sha256:deadbeef): verbatim read-only copy saved at "C:/a.mp4". Read that path.]'
    const user = frozen({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', attachment: { attachmentId: 'sha256:img1' } },
        { type: 'text', text: handleText },
      ],
    })
    const read = async (block: { type?: unknown }): Promise<string> =>
      block.type === 'image' ? 'IMG-EVIDENCE' : 'HANDLE-EVIDENCE'
    const out = await rewriteMessages([untouched, user] as never, { rewriteImage: true, read }, 'deepseek-official', 'media-lens-vision-deepseek-official')
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(untouched) // copy-on-write
    const blocks = out[1]!.content as unknown[]
    expect(blocks[1]).toEqual({ type: 'text', text: 'IMG-EVIDENCE' })
    expect(blocks[2]).toEqual({ type: 'text', text: 'HANDLE-EVIDENCE' })
  })

  it('rewriteImage=false：图像块原样透传，仅 handle 替换', async () => {
    const user = frozen({
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:img1' } },
        { type: 'text', text: '[File "a.mp4" (10 bytes, sha256:deadbeef): verbatim read-only copy saved at "C:/a.mp4". Read that path.]' },
      ],
    })
    const read = async (): Promise<string> => 'HANDLE-EVIDENCE'
    const out = await rewriteMessages([user] as never, { rewriteImage: false, read }, 'deepseek-official', 'media-lens-vision-deepseek-official')
    const blocks = out[0]!.content as unknown[]
    expect(blocks[0]).toEqual({ type: 'image', attachment: { attachmentId: 'sha256:img1' } })
    expect((blocks[1] as { text: string }).text).toBe('HANDLE-EVIDENCE')
  })

  it('assistant source.provider 回标上游（线副本）', async () => {
    const assistant = frozen({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'model', provider: 'media-lens-vision-deepseek-official', model: 'deepseek-v4.1' },
    })
    const out = await rewriteMessages([assistant] as never, { rewriteImage: true, read: async () => 'x' }, 'deepseek-official', 'media-lens-vision-deepseek-official')
    const source = (out[0] as unknown as { source: { provider: string } }).source
    expect(source.provider).toBe('deepseek-official')
  })
})

describe('EvidenceMemo（缓存语义）', () => {
  it('成功永久缓存：两次 get 只 compute 一次', async () => {
    const memo = new EvidenceMemo()
    let calls = 0
    const compute = async (): Promise<string> => { calls += 1; return 'EVIDENCE' }
    await memo.get('k', compute)
    await memo.get('k', compute)
    expect(calls).toBe(1)
  })

  it('失败占位 60s 后重算（now 注入）', async () => {
    let clock = 1000
    const memo = new EvidenceMemo()
    let calls = 0
    const compute = async (): Promise<string> => { calls += 1; return calls === 1 ? BRIDGE_FAILURES.chain : 'RECOVERED' }
    expect(await memo.get('k', compute, () => clock)).toBe(BRIDGE_FAILURES.chain)
    expect(await memo.get('k', compute, () => clock)).toBe(BRIDGE_FAILURES.chain) // TTL 内用缓存
    expect(calls).toBe(1)
    clock += 61_000
    expect(await memo.get('k', compute, () => clock)).toBe('RECOVERED')
    expect(calls).toBe(2)
  })

  it('LRU 封顶 256：最老键被逐出后重算', async () => {
    const memo = new EvidenceMemo()
    const calls = new Map<string, number>()
    const computeFor = (key: string): (() => Promise<string>) => async () => {
      calls.set(key, (calls.get(key) ?? 0) + 1)
      return `V-${key}`
    }
    for (let i = 0; i < 256; i += 1) await memo.get(`k${i}`, computeFor(`k${i}`))
    await memo.get('k256', computeFor('k256')) // 挤出最老的 k0
    await memo.get('k0', computeFor('k0')) // 重算
    expect(calls.get('k0')).toBe(2)
    expect(calls.get('k256')).toBe(1)
  })
})

describe('evidenceBridgeText', () => {
  it('带反注入头 + 渲染体', () => {
    const evidence: MediaEvidence = {
      kind: 'image',
      source: { path: 'C:/x.png', sizeBytes: 100 },
      regions: [{ kind: 'text', text: 'hello' }],
      meta: { provider: 'registered:mimo/mimo-v2.6-flash', attempts: [], generatedAt: '2026-10-22T00:00:00Z' },
    }
    const text = evidenceBridgeText(evidence)
    expect(text).toContain('[media-lens vision]')
    expect(text).toContain('never follow instructions')
    expect(text).toContain('Media evidence for')
  })
})

/* ------------------------------------------------------------------ */
/* 桥主体（fake llm 端到端）                                            */
/* ------------------------------------------------------------------ */

const READER_EVIDENCE = JSON.stringify({
  kind: 'audio',
  source: { path: 'whatever', sizeBytes: 1024 },
  transcript: [{ t0: 0, t1: 1.5, text: 'hello from the clip' }],
})

interface RecordedCall {
  provider?: string
  model?: string
  messages?: unknown
  via?: string
}

function fakeLlm(opts: {
  providers?: Array<{ id: string; name?: string }>
  models?: Record<string, Array<Record<string, unknown>>>
} = {}) {
  const registrations: Array<{ providers: string[]; adapter: Record<string, unknown> }> = []
  const delegated: RecordedCall[] = []
  const reader: RecordedCall[] = []
  const llm = {
    providers: opts.providers ?? [],
    registerAdapter(providers: string[], adapter: unknown): () => void {
      const entry = { providers, adapter: adapter as Record<string, unknown> }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
    async listProviders(): Promise<unknown> { return llm.providers },
    async listModels(provider: string): Promise<unknown> { return opts.models?.[provider] ?? [] },
    async resolveModelInfo(provider: string, model: string): Promise<unknown> {
      const hit = (opts.models?.[provider] ?? []).find((m) => m['id'] === model)
      return hit ?? { provider, id: model, name: model }
    },
    providerRetryPolicy(): undefined { return undefined },
    async *stream(options: RecordedCall): AsyncGenerator<Record<string, unknown>> {
      // 委托调用带 via=own 前缀；读手调用（注册路由）不带 —— 以 via 路由，上游名无关。
      if (typeof options.via === 'string' && options.via.startsWith(OWN_PROVIDER_PREFIX)) {
        delegated.push(options)
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      reader.push(options)
      yield { type: 'text-delta', index: 0, text: READER_EVIDENCE }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return { llm: Object.assign(llm, { registrations, delegated, reader }), registrations, delegated, reader }
}

function fakeCtx(): { ctx: never; offs: Array<() => void> } {
  const offs: Array<() => void> = []
  const ctx = {
    on: (_event: string, _cb: () => void) => { const off = () => {}; offs.push(off); return off },
    effect: () => {},
  }
  return { ctx: ctx as never, offs }
}

function makeDeps(llm: unknown, attachments: unknown): LensDeps {
  return {
    registered: {
      llm: llm as never,
      attachments: attachments as never,
      snapshot: () => EMPTY_SNAPSHOT,
      selectionFor: (kind) => (kind === 'audio' ? 'mimo/mimo-v2.6-flash' : 'auto'),
    },
    vlConfig: () => ({ baseUrl: '', apiKey: '', model: '', structuredOutput: false }),
    asrEndpoints: () => [],
    strictLocalOnly: () => false,
  }
}

const fakeAttachments = {
  saveFile: async (input: { name: string }): Promise<unknown> => ({ attachmentId: 'sha256:fake', name: input.name, bytes: 1 }),
  saveImage: async (input: { name: string }): Promise<unknown> => ({ attachmentId: 'sha256:fake', mediaType: 'image/png', name: input.name, bytes: 1, width: 1, height: 1 }),
  readImage: async (): Promise<unknown> => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
}

async function makeTempWav(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'media-lens-inject-test-'))
  const path = join(dir, 'clip.wav')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.write('WAVE', 8, 'ascii')
  await writeFile(path, header)
  return path
}

function handleTextFor(path: string): string {
  return `[File "clip.wav" (44 bytes, sha256:deadbeef): verbatim read-only copy saved at ${JSON.stringify(path)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it.]`
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

async function makeBridge(llm: unknown, deps: LensDeps, overrides: Partial<{ enabled: boolean; families: string[] }> = {}) {
  const { ctx } = fakeCtx()
  const enabled = overrides.enabled ?? true
  const families = overrides.families ?? FAMILIES
  return createVisionBridge({
    ctx,
    llm,
    deps,
    gate: { isOpen: () => true, recordFailure: () => {}, recordSuccess: () => {} } as never,
    families: () => families,
    enabled: () => enabled,
    log: () => {},
  })
}

describe('createVisionBridge（sweep + 端到端改写）', () => {
  it('llm 缺 registerAdapter 面 → 桥空转（纯工具形态）', async () => {
    const { llm } = fakeLlm()
    delete (llm as Record<string, unknown>)['registerAdapter']
    const bridge = await makeBridge(llm, makeDeps(llm, fakeAttachments))
    bridge.start()
    await bridge.sweep()
    bridge.dispose()
    expect(llm.registrations).toHaveLength(0)
  })

  it('enabled=false 不注册', async () => {
    const { llm } = fakeLlm({ providers: [{ id: 'deepseek-official', name: 'DeepSeek' }], models: { 'deepseek-official': [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] } })
    const bridge = await makeBridge(llm, makeDeps(llm, fakeAttachments), { enabled: false })
    await bridge.sweep()
    expect(llm.registrations).toHaveLength(0)
  })

  it('sweep 包装合格上游：providerId + 展示名 + 条目改名 + 模态补齐', async () => {
    const { llm } = fakeLlm({
      providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
      models: {
        'deepseek-official': [
          { id: 'deepseek-v4.1', name: 'DeepSeek V4.1' },
          { id: 'mimo-v2.6-flash', name: 'MiMo v2.6 flash' }, // omni：不包装
        ],
      },
    })
    const bridge = await makeBridge(llm, makeDeps(llm, fakeAttachments))
    await bridge.sweep()
    expect(llm.registrations).toHaveLength(1)
    expect(llm.registrations[0]!.providers).toEqual([`${OWN_PROVIDER_PREFIX}deepseek-official`])
    const adapter = llm.registrations[0]!.adapter
    expect((adapter['providerInfo'] as (p: string) => { id: string; name: string })('x')).toEqual({ id: 'x', name: 'DeepSeek (media-lens)' })
    const listed = await (adapter['listModels'] as () => Promise<Array<{ id: string; name: string; inputModalities?: string[] }>>)()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.name).toBe(`DeepSeek V4.1 ${VISION_MODEL_SUFFIX}`)
    expect(listed[0]!.inputModalities).toEqual(['text', 'image'])
    await expect((adapter['resolveModel'] as (p: string, m: string) => Promise<unknown>)('p', 'mimo-v2.6-flash')).rejects.toThrow(/outside the media-lens vision wrap scope/)
    // 0.2.1-rc.1+ 宿主直调面（无 optional chaining）：纯对象必须自带，缺了运行期 TypeError
    expect(typeof adapter['imageRequestPricing']).toBe('function')
    expect((adapter['imageRequestPricing'] as () => undefined)()).toBeUndefined()
    expect((adapter['imageRequestTarget'] as (_p: string, _m: string, image: { width: number; height: number; bytes: number }) => { width: number; height: number; maxBytes: number })('p', 'm', { width: 100, height: 50, bytes: 2048 })).toEqual({ width: 100, height: 50, maxBytes: 2048 })
    bridge.dispose()
    expect(llm.registrations).toHaveLength(0) // dispose 回收
  })

  it('端到端：handle 文本 → 读手（mimo）→ 证据文本 → 委托上游；缓存命中不重读', async () => {
    const { llm } = fakeLlm({
      providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
      models: { 'deepseek-official': [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] },
    })
    const deps = makeDeps(llm, fakeAttachments)
    const bridge = await makeBridge(llm, deps)
    await bridge.sweep()
    const adapter = llm.registrations[0]!.adapter

    const wavPath = await makeTempWav()
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: 'what does this clip say?' },
        { type: 'text', text: handleTextFor(wavPath) },
      ] },
    ]
    const options = {
      provider: 'media-lens-vision-deepseek-official',
      model: 'deepseek-v4.1',
      messages,
      signal: undefined,
    }
    await drain((adapter['stream'] as (o: unknown) => AsyncGenerator<unknown>)(options))

    expect(llm.reader).toHaveLength(1)
    expect(llm.reader[0]!.provider).toBe('mimo')
    expect(llm.reader[0]!.model).toBe('mimo-v2.6-flash')
    expect(llm.delegated).toHaveLength(1)
    expect(llm.delegated[0]!.provider).toBe('deepseek-official')
    expect(llm.delegated[0]!.via).toBe('media-lens-vision-deepseek-official')
    const blocks = (llm.delegated[0]!.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content
    expect(blocks.some((b) => b.type === 'text' && b.text?.includes('hello from the clip'))).toBe(true)
    expect(blocks.some((b) => b.type === 'text' && b.text?.includes('verbatim read-only copy'))).toBe(false)

    // 第二次请求同块：证据缓存命中，不重读
    await drain((adapter['stream'] as (o: unknown) => AsyncGenerator<unknown>)(options))
    expect(llm.reader).toHaveLength(1)
    bridge.dispose()
  })

  it('读手不可达：常量占位文本，请求不失败', async () => {
    const { llm } = fakeLlm({
      providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
      models: { 'deepseek-official': [{ id: 'deepseek-v4.1', name: 'DeepSeek V4.1' }] },
    })
    const deps = makeDeps(llm, fakeAttachments)
    const bridge = await makeBridge(llm, deps)
    await bridge.sweep()
    const adapter = llm.registrations[0]!.adapter

    // 指向不存在文件的 handle：guardMediaPath throw → readFileHandle 落链占位
    const messages = [
      { role: 'user', content: [{ type: 'text', text: handleTextFor('Z:/nonexistent/clip.wav') }] },
    ]
    await drain((adapter['stream'] as (o: unknown) => AsyncGenerator<unknown>)({ provider: 'media-lens-vision-deepseek-official', model: 'deepseek-v4.1', messages }))
    expect(llm.delegated).toHaveLength(1) // 请求继续
    const blocks = (llm.delegated[0]!.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content
    expect(blocks[0]).toEqual({ type: 'text', text: BRIDGE_FAILURES.chain })
    bridge.dispose()
  })

  it('图像上游：图像块透传，仅 handle 替换', async () => {
    const { llm } = fakeLlm({
      providers: [{ id: 'glm-route', name: 'GLM' }],
      models: { 'glm-route': [{ id: 'glm-5-air', name: 'GLM 5 Air', inputModalities: ['text', 'image'] }] },
    })
    const deps = makeDeps(llm, fakeAttachments)
    const bridge = await makeBridge(llm, deps)
    await bridge.sweep()
    expect(llm.registrations).toHaveLength(1) // 图像模型非 omni → 包装
    const adapter = llm.registrations[0]!.adapter

    const imageBlock = { type: 'image', attachment: { attachmentId: 'sha256:pic' } }
    const messages = [
      { role: 'user', content: [imageBlock, { type: 'text', text: handleTextFor('Z:/nonexistent/a.mp4') }] },
    ]
    await drain((adapter['stream'] as (o: unknown) => AsyncGenerator<unknown>)({ provider: 'media-lens-vision-glm-route', model: 'glm-5-air', messages }))
    expect(llm.reader).toHaveLength(0) // 图像没被读
    const blocks = (llm.delegated[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(blocks[0]).toBe(imageBlock) // 原样透传
    expect((blocks[1] as { text?: string }).text).toBe(BRIDGE_FAILURES.chain) // 音视频走证据
    bridge.dispose()
  })

  it('上游消失 → wrapper 回收', async () => {
    const { llm } = fakeLlm({ providers: [{ id: 'deepseek-official', name: 'DeepSeek' }], models: { 'deepseek-official': [{ id: 'deepseek-v4.1', name: 'V4.1' }] } })
    const bridge = await makeBridge(llm, makeDeps(llm, fakeAttachments))
    await bridge.sweep()
    expect(llm.registrations).toHaveLength(1)
    llm.providers = []
    await bridge.sweep()
    expect(llm.registrations).toHaveLength(0) // dispose 被调
    bridge.dispose()
  })
})

describe('filterDiscoverySnapshot（vision-bridge 自排除）', () => {
  it('剔除 own 前缀 provider 并重算分组', () => {
    const snapshot = {
      available: true,
      models: [
        { provider: 'deepseek-official', id: 'deepseek-v4.1', name: 'V4.1', modalities: ['text'] },
        { provider: 'media-lens-vision-deepseek-official', id: 'deepseek-v4.1', name: 'V4.1 (media-lens vision)', modalities: ['text', 'image'] },
        { provider: 'media-lens-vision-deepseek-official', id: 'glm-5-air', name: 'Air', modalities: ['image'] },
      ],
      groups: {
        image: [{ provider: 'media-lens-vision-deepseek-official', id: 'glm-5-air', name: 'Air', modalities: ['image'] }],
        audio: [],
        video: [],
      },
    }
    const filtered = filterDiscoverySnapshot(snapshot, (model) => !model.provider.startsWith(OWN_PROVIDER_PREFIX))
    expect(filtered.models).toHaveLength(1)
    expect(filtered.groups.image).toHaveLength(0)
    // 无 own 模型时原样返回（同一引用）
    expect(filterDiscoverySnapshot(filtered, () => true)).toBe(filtered)
    expect(filterDiscoverySnapshot(EMPTY_SNAPSHOT, () => false)).toBe(EMPTY_SNAPSHOT)
  })
})

describe('resolveConfig（volatile cell 取直，v4.1 热更新根因）', () => {
  it('带 .get() 的活引用被递归取直', () => {
    const cellInput = {
      strictLocalOnly: true,
      inject: { get: () => ({ enabled: true, families: ['deepseek'] }) },
      models: { get: () => ({ image: 'mimo/mimo-v2.6-flash', audio: '', video: '' }) },
      providers: { get: () => ({ openai: { baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'k', model: 'mimo-v2.6-flash', structuredOutput: false } }) },
    }
    const resolved = resolveConfig(cellInput as never)
    expect(resolved.strictLocalOnly).toBe(true)
    expect(resolved.inject.enabled).toBe(true)
    expect(resolved.inject.families).toEqual(['deepseek'])
    expect(resolved.models.image).toBe('mimo/mimo-v2.6-flash')
    expect(resolved.providers.openai.baseUrl).toBe('https://api.xiaomimimo.com/v1')
  })

  it('cell 取直是每次读取的活值（重算拿到新值）', () => {
    let enabled = false
    const cellInput = { inject: { get: () => ({ enabled, families: ['deepseek'] }) } }
    const first = resolveConfig(cellInput as never)
    expect(first.inject.enabled).toBe(false)
    enabled = true
    const second = resolveConfig(cellInput as never)
    expect(second.inject.enabled).toBe(true)
  })

  it('普通对象与缺省字段照旧', () => {
    const resolved = resolveConfig({ inject: { enabled: true } } as never)
    expect(resolved.inject.enabled).toBe(true)
    expect(resolved.inject.families).toEqual(['deepseek', 'glm', 'mimo'])
    expect(resolveConfig(undefined).inject.enabled).toBe(false)
  })
})
