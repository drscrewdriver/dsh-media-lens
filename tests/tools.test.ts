import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardMediaPath } from '../src/tools/path-guard.ts'
import { buildLensRequest } from '../src/tools/tool-kit.ts'
import { createLocalFileProvider } from '../src/providers/local-file.ts'
import { runChain } from '../src/router/failover.ts'

let dir: string

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
const MP4_HEADER = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])
const WAV_HEADER = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])

describe('路径守卫（M16 / C5 / M27 magic-byte）', () => {
  it('不存在的文件明确报错', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    await expect(guardMediaPath(join(dir, 'ghost.mp4'), 'video', dir)).rejects.toThrow(/not found/)
  })

  it('扩展名不支持明确报错并列出支持清单', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const avi = join(dir, 'clip.avi')
    await writeFile(avi, 'x')
    await expect(guardMediaPath(avi, 'video', dir)).rejects.toThrow(/\.avi.*mp4/)
  })

  it('扩展名与媒体种类不匹配拒绝（jpg 不是 audio）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const jpg = join(dir, 'pic.jpg')
    await writeFile(jpg, PNG_HEADER)
    await expect(guardMediaPath(jpg, 'audio', dir)).rejects.toThrow(/not a supported audio/)
  })

  it('空路径拒绝', async () => {
    await expect(guardMediaPath('  ', 'image', undefined)).rejects.toThrow(/empty/)
  })

  it('伪扩展拒绝：txt 内容改名 .png（M27）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const fake = join(dir, 'fake.png')
    await writeFile(fake, 'plain text pretending to be an image')
    await expect(guardMediaPath(fake, 'image', dir)).rejects.toThrow(/does not look like a supported image/)
  })

  it('真头放行：png/mp4/wav 各自的头字节通过（M27 正例）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const png = join(dir, 'a.png')
    await writeFile(png, PNG_HEADER)
    const mp4 = join(dir, 'b.mp4')
    await writeFile(mp4, MP4_HEADER)
    const wav = join(dir, 'c.wav')
    await writeFile(wav, WAV_HEADER)
    expect((await guardMediaPath(png, 'image', dir)).sizeBytes).toBe(PNG_HEADER.length)
    expect((await guardMediaPath(mp4, 'video', dir)).sizeBytes).toBe(MP4_HEADER.length)
    expect((await guardMediaPath(wav, 'audio', dir)).sizeBytes).toBe(WAV_HEADER.length)
  })

  it('合法路径返回绝对路径与大小', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const wav = join(dir, 'a.wav')
    await writeFile(wav, WAV_HEADER)
    const guarded = await guardMediaPath('a.wav', 'audio', dir)
    expect(guarded.absPath.toLowerCase()).toBe(wav.toLowerCase())
    expect(guarded.sizeBytes).toBe(WAV_HEADER.length)
  })
})

describe('请求构建（probe + budget 分派）', () => {
  it('mp4 假文件（ffprobe 失败）→ 大小守恒、budget 按大小分派', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const mp4 = join(dir, 'v.mp4')
    await writeFile(mp4, MP4_HEADER)
    const request = await buildLensRequest({ path: mp4, instruction: ' find the bug ' }, 'video', dir)
    expect(request.sizeBytes).toBe(MP4_HEADER.length)
    expect(request.budget).toBe('full')
    expect(request.instruction).toBe('find the bug')
  })
})

describe('local-file 兜底（task_19）', () => {
  it('degraded 标记 + 元数据时间线', async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-lens-test-'))
    const png = join(dir, 'x.png')
    await writeFile(png, PNG_HEADER)
    const chunk = await createLocalFileProvider().run({
      path: png, sizeBytes: 16, media: 'image', budget: 'full',
    })
    expect(chunk.meta.degraded).toBe('local-metadata-only')
    expect(chunk.meta.provider).toBe('local:metadata')
    expect(chunk.timeline?.[0]?.text).toContain('Metadata only')
  })

  it('空链报 no provider configured（M9 端到端）', async () => {
    await expect(runChain([], { path: 'x', sizeBytes: 1, media: 'image', budget: 'full' })).rejects.toThrow(/no provider configured for image/)
  })
})

describe('工具注册面（task_23 契约）', () => {
  it('三工具定义：名称/描述触发词/参数 schema（FR-8）', async () => {
    vi.resetModules()
    const { createReadImageTool } = await import('../src/tools/read-image.ts')
    const { createReadAudioTool } = await import('../src/tools/read-audio.ts')
    const { createReadVideoTool } = await import('../src/tools/read-video.ts')
    const noop = (): void => {}
    const deps = {
      registered: {
        llm: {} as never,
        attachments: {} as never,
        snapshot: () => ({ available: false, models: [], groups: { image: [], audio: [], video: [] } }),
        selectionFor: () => 'auto',
      },
      vlConfig: () => ({ baseUrl: 'https://vl.example', apiKey: 'k', model: 'm' }),
      asrEndpoints: () => [],
      strictLocalOnly: () => false,
    }
    const gate = { record: noop, isOpen: () => true } as never
    const image = createReadImageTool(deps, gate, noop)
    const audio = createReadAudioTool(deps, gate, noop)
    const video = createReadVideoTool(deps, gate, noop)
    expect(image.name).toBe('media_read_image')
    expect(audio.name).toBe('media_read_audio')
    expect(video.name).toBe('media_read_video')
    expect(image.description).toMatch(/image/i)
    expect(audio.description).toMatch(/audio|wav|mp3/i)
    expect(video.description).toMatch(/video|mp4/i)
    // M3：output 契约同一（json schema + render 输出 text 块数组）
    for (const tool of [image, audio, video]) {
      expect(tool.output.render).toBeTypeOf('function')
    }
    const rendered = image.output.render as (args: unknown, value: unknown) => { type: string; text: string }[]
    const sample = {
      kind: 'image',
      source: { path: 'p.png', sizeBytes: 1 },
      regions: [{ text: 'A', kind: 'title' }],
      meta: { provider: 'configured:openai', attempts: [{ provider: 'configured:openai', ok: true, ms: 3 }], generatedAt: 'g' },
    }
    const blocks = rendered({}, sample)
    expect(blocks[0]?.text).toContain('configured:openai')
    expect(blocks.map((b) => b.text).join('\n')).toContain('A')
  })
})
