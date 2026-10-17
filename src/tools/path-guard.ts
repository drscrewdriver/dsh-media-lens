/**
 * 媒体路径入参守卫（M16 / C5）：存在性 + 扩展名白名单 + 绝对化。
 * 媒体内容按不可信输入处理：只读取，永不执行。
 */

import { open, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type { MediaKind } from '../evidence.ts'

export const EXTENSIONS: Record<MediaKind, ReadonlySet<string>> = {
  video: new Set(['.mp4', '.webm', '.mov', '.mkv']),
  audio: new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.wma']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']),
}

export interface GuardedPath {
  absPath: string
  sizeBytes: number
}

/**
 * FR-14 magic-byte sniff：扩展名只是路由提示，内容必须自证（modlens imageInput
 * "no extension trust" 的全媒体版）。手写字节签名，禁扩展名信任。
 */
const SNIFFERS: Record<MediaKind, Array<{ mime: string; test: (b: Buffer) => boolean }>> = {
  image: [
    { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { mime: 'image/gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
    { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
    { mime: 'image/bmp', test: (b) => b.length >= 2 && b.toString('ascii', 0, 2) === 'BM' },
  ],
  video: [
    { mime: 'video/mp4', test: (b) => b.length >= 8 && b.toString('ascii', 4, 8) === 'ftyp' },
    { mime: 'video/quicktime', test: (b) => b.length >= 8 && b.toString('ascii', 4, 8) === 'ftyp' },
    { mime: 'video/webm', test: (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
    { mime: 'video/x-matroska', test: (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  ],
  audio: [
    { mime: 'audio/wav', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'RIFF' },
    { mime: 'audio/mpeg', test: (b) => b.length >= 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) },
    { mime: 'audio/flac', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC' },
    { mime: 'audio/ogg', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS' },
    { mime: 'audio/mp4', test: (b) => b.length >= 8 && b.toString('ascii', 4, 8) === 'ftyp' },
    { mime: 'audio/aac', test: (b) => b.length >= 2 && b[0] === 0xff && (b[1] === 0xf1 || b[1] === 0xf9) },
    { mime: 'audio/x-ms-wma', test: (b) => b.length >= 16 && b.toString('hex', 0, 16) === '3026b2758e66cf11a6d900aa0062ce6c' },
  ],
}

/** 读头 16 字节自证类型；伪扩展（内容对不上任何已知头）拒绝。 */
export async function sniffMediaHeader(absPath: string, kind: MediaKind): Promise<void> {
  const handle = await open(absPath, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const { bytesRead } = await handle.read(buffer, 0, 16, 0)
    const head = buffer.subarray(0, bytesRead)
    if (SNIFFERS[kind].some(({ test }) => test(head))) return
    throw new Error(
      `content of "${absPath.split(/[\\/]/).pop()}" does not look like a supported ${kind} (its bytes match no known ${kind} header) — renamed files are refused`,
    )
  } finally {
    await handle.close()
  }
}

/** 相对路径按会话 cwd（dsh-video-read 同款）解析；不存在/扩展名/头字节不合规 → 明确报错。 */
export async function guardMediaPath(
  input: string,
  kind: MediaKind,
  cwd: string | undefined,
): Promise<GuardedPath> {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('media path is empty')
  const absPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(join(cwd ?? process.cwd(), trimmed))
  const info = await stat(absPath).catch(() => undefined)
  if (info === undefined) throw new Error(`media file not found: ${absPath}`)
  if (!info.isFile()) throw new Error(`not a file: ${absPath}`)
  const ext = extname(absPath).toLowerCase()
  if (!EXTENSIONS[kind].has(ext)) {
    throw new Error(`"${ext || basenameOf(absPath)}" is not a supported ${kind} type (supported: ${[...EXTENSIONS[kind]].join(' ')}), got "${basenameOf(absPath)}"`)
  }
  await sniffMediaHeader(absPath, kind)
  return { absPath, sizeBytes: info.size }
}

function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx === -1 ? path : path.slice(idx + 1)
}
