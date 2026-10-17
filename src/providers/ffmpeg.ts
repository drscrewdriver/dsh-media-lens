/**
 * ffmpeg / ffprobe 桥（FR-2 抽帧兜底 + FR-6 预算降级的执行器）。
 * 全部 spawn 参数数组（S1，禁 shell 字符串拼接），路径空格安全。
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import type { FrameRef } from '../router/registry.ts'

const execFileAsync = promisify(execFile)

export interface MediaProbe {
  sizeBytes: number
  durationSec?: number
  resolution?: [number, number]
}

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
}

interface FfprobeOutput {
  format?: { duration?: string; size?: string }
  streams?: FfprobeStream[]
}

/** ffprobe 探测时长/分辨率；ffprobe 不可用或解析失败只保 stat 大小。 */
export async function probe(path: string): Promise<MediaProbe> {
  const info = await stat(path)
  const result: MediaProbe = { sizeBytes: info.size }
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
    const parsed = JSON.parse(stdout) as FfprobeOutput
    const duration = Number(parsed.format?.duration)
    if (Number.isFinite(duration) && duration >= 0) result.durationSec = duration
    const video = parsed.streams?.find((s) => s.codec_type === 'video')
    if (typeof video?.width === 'number' && typeof video?.height === 'number') {
      result.resolution = [video.width, video.height]
    }
  } catch {
    // ffprobe 缺失/格式不认：元数据降级为仅大小，调用方自行裁量。
  }
  return result
}

/** ffmpeg 是否在 PATH 上（进程内缓存一次）。 */
let ffmpegUsable: boolean | undefined
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegUsable === undefined) {
    try {
      await execFileAsync('ffmpeg', ['-version'], { timeout: 10_000 })
      ffmpegUsable = true
    } catch {
      ffmpegUsable = false
    }
  }
  return ffmpegUsable
}

/** 540p x264 快速重编码（10–19MB 档），失败返回 undefined。 */
export async function reencode(path: string, height = 540, crf = 28): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'media-lens-reencode-'))
  try {
    const outPath = join(dir, `${basename(path, extname(path))}-${height}p.mp4`)
    await execFileAsync('ffmpeg', [
      '-y', '-i', path,
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      outPath,
    ], { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
    return outPath
  } catch {
    return undefined
  }
}

/**
 * 均匀抽 n 帧（时间点取每段中点），写独立临时目录的 jpg。
 * 返回按时间升序的 FrameRef[]；失败抛错由链记录。
 */
export async function sampleFrames(path: string, count: number, durationSec: number): Promise<FrameRef[]> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`cannot sample frames: duration unknown for ${basename(path)}`)
  }
  const safeCount = Math.max(1, Math.min(24, Math.floor(count)))
  const dir = await mkdtemp(join(tmpdir(), 'media-lens-frames-'))
  const frames: FrameRef[] = []
  try {
    for (let i = 0; i < safeCount; i++) {
      const t = ((i + 0.5) / safeCount) * durationSec
      const outPath = join(dir, `frame-${String(i).padStart(2, '0')}.jpg`)
      await execFileAsync('ffmpeg', [
        '-y', '-ss', t.toFixed(3), '-i', path,
        '-frames:v', '1', '-q:v', '3',
        outPath,
      ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
      frames.push({ t, path: outPath })
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  if (frames.length === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw new Error(`ffmpeg produced no frames for ${basename(path)}`)
  }
  return frames
}

/** 读帧字节（送 VL 端点用）。 */
export async function readFrameBytes(path: string): Promise<Uint8Array> {
  return readFile(path)
}

/** 清理抽帧/重编码临时目录。 */
export async function cleanupPaths(paths: string[]): Promise<void> {
  const dirs = new Set(paths.map((p) => join(p, '..')))
  await Promise.all([...dirs].map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}
