/**
 * ASR shell 桥（FR-3 音频路①）：spawn 本地转写 CLI（SenseVoice /
 * batch-voice-transcriber 等 Python 裸跑资产），命令模板 {input} 占位。
 * 输出适配两种 fixture：JSON segments 与 SRT/时间行文本（S2）。
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Chunk } from '../evidence.ts'
import { makeChunk } from '../evidence.ts'
import type { LensRequest, Provider } from '../router/registry.ts'
import { hasSubstantiveText } from './evidence-parse.ts'

export interface TranscriptEntry {
  t0: number
  t1: number
  speaker?: string
  text: string
}

/** 命令模板分词：双引号内空格不切分；{input} 占位替换（含引号包裹形态）。 */
export function tokenizeCommand(template: string, inputPath: string): string[] {
  const resolved = template.replace(/\{input\}/g, inputPath)
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of resolved) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ' ' && !inQuotes) {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function toSeconds(stamp: string): number | undefined {
  const trimmed = stamp.trim().replace(',', '.')
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const parts = trimmed.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return undefined
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  return undefined
}

interface RawSegment {
  start?: unknown
  end?: unknown
  t0?: unknown
  t1?: unknown
  from?: unknown
  to?: unknown
  speaker?: unknown
  text?: unknown
}

function entryFromSegment(seg: RawSegment): TranscriptEntry | undefined {
  const t0 = toSeconds(String(seg.start ?? seg.t0 ?? seg.from ?? ''))
  const t1 = toSeconds(String(seg.end ?? seg.t1 ?? seg.to ?? ''))
  const text = typeof seg.text === 'string' ? seg.text.trim() : ''
  if (t0 === undefined || t1 === undefined || text === '') return undefined
  return {
    t0,
    t1,
    ...(typeof seg.speaker === 'string' && seg.speaker !== '' ? { speaker: seg.speaker } : {}),
    text,
  }
}

function fromJsonSegments(parsed: unknown): TranscriptEntry[] | undefined {
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { segments?: unknown })['segments'])
      ? (parsed as { segments: unknown[] })['segments']
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { transcript?: unknown })['transcript'])
        ? (parsed as { transcript: unknown[] })['transcript']
        : undefined
  if (list === undefined) return undefined
  const entries = list
    .map((item) => (typeof item === 'object' && item !== null ? entryFromSegment(item as RawSegment) : undefined))
    .filter((e): e is TranscriptEntry => e !== undefined)
  return entries.length > 0 ? entries : undefined
}

const SRT_ARROW = '-->'

function fromTimestampLines(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let pending: { t0: number; t1: number } | undefined
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^\d+$/.test(trimmed)) continue // SRT 序号行
    const arrow = trimmed.indexOf(SRT_ARROW)
    if (arrow !== -1) {
      const t0 = toSeconds(trimmed.slice(0, arrow))
      const rest = trimmed.slice(arrow + SRT_ARROW.length)
      const t1 = toSeconds(rest.split(/\s{2,}/)[0] ?? rest.trim())
      if (t0 !== undefined && t1 !== undefined) pending = { t0, t1 }
      continue
    }
    const paired = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*[-–~]\s*(\d+(?:[.,]\d+)?)\s+(.*)$/)
    if (paired) {
      const t0 = toSeconds(paired[1]!)
      const t1 = toSeconds(paired[2]!)
      const text = paired[3]!.trim()
      if (t0 !== undefined && t1 !== undefined && text !== '') entries.push({ t0, t1, text })
      continue
    }
    if (pending !== undefined) {
      const text = trimmed
      entries.push({ t0: pending.t0, t1: pending.t1, text })
      pending = undefined
    }
  }
  return entries
}

/** 转写输出适配层（S2）：JSON 优先，SRT/时间行兜底；空输出抛错。 */
export function parseTranscription(raw: string): TranscriptEntry[] {
  if (!hasSubstantiveText(raw)) throw new Error('asr produced no output')
  try {
    const fromJson = fromJsonSegments(JSON.parse(raw) as unknown)
    if (fromJson !== undefined) return fromJson
  } catch {
    // 非 JSON，走文本行解析
  }
  const entries = fromTimestampLines(raw)
  if (entries.length === 0) throw new Error('asr output not recognizable as segments or timestamps')
  return entries.sort((a, b) => a.t0 - b.t0)
}

export function executeCommand(tokens: string[], timeoutMs: number): Promise<string> {
  const [file, ...args] = tokens
  if (file === undefined) return Promise.reject(new Error('asr command template is empty'))
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        reject(new Error(`asr command timed out after ${timeoutMs}ms`))
      }
    }, timeoutMs)
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf8') })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`asr command failed to start: ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0 && stdout.trim() !== '') resolve(stdout)
      else reject(new Error(`asr command exited ${code}${stderr.trim() !== '' ? `: ${stderr.trim().slice(0, 400)}` : ''}`))
    })
  })
}

/** 构造一个 ASR 端点 provider（一个端点 = 链上一个成员，M18 切换即换链）。 */
export function createAsrProvider(endpoint: { name: string; command: string }, timeoutMs = 1_200_000): Provider {
  return {
    name: `asr:${endpoint.name}`,
    media: ['audio'],
    remote: false,
    available: () => endpoint.command.trim() !== '',
    async run(req: LensRequest, _signal?: AbortSignal): Promise<Chunk> {
      const tokens = tokenizeCommand(endpoint.command, req.path)
      const stdout = await executeCommand(tokens, timeoutMs)
      const entries = parseTranscription(stdout)
      return makeChunk({
        kind: 'audio',
        source: { path: req.path, sizeBytes: req.sizeBytes, ...(req.durationSec !== undefined ? { durationSec: req.durationSec } : {}) },
        transcript: entries,
        meta: { provider: `asr:${endpoint.name}`, ...(req.budget === 'segment' ? { degraded: 'segment-budget' } : {}) },
      })
    },
  }
}

/** 读端点输出文件场景：模板可输出到 stdout，这里仅保留 readFile 供测试用。 */
export async function readMaybeFile(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
