/**
 * 三工具共用的输出 render 与调用卡：把 MediaEvidence 摘成模型/用户可读文本，
 * 引导模型引用具体帧/秒/说话人（Evidence, not imagination）。
 */

import type { MediaEvidence } from '../evidence.ts'

function lastErrorOf(evidence: MediaEvidence): string | undefined {
  const failed = evidence.meta.attempts.filter((a) => !a.ok)
  return failed[failed.length - 1]?.error
}

export function evidenceRender(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  const lines: string[] = []
  if (typeof value !== 'object' || value === null) {
    return [{ type: 'text', text: 'media-lens returned a non-object payload' }]
  }
  const evidence = value as MediaEvidence
  const provider = evidence.meta?.provider ?? 'unknown'
  const attemptCount = evidence.meta?.attempts?.length ?? 0
  const degraded = evidence.meta?.degraded
  const head = `Media evidence for "${evidence.source?.path ?? '?'}" via ${provider}${degraded !== undefined ? ` (degraded: ${degraded})` : ''} [${attemptCount} attempt(s)]`
  lines.push(head)
  if (evidence.timeline !== undefined && evidence.timeline.length > 0) {
    lines.push(`Timeline (${evidence.timeline.length}): ${evidence.timeline.slice(0, 8).map((e) => `t=${e.t.toFixed(1)}s ${e.text}`).join(' | ')}${evidence.timeline.length > 8 ? ' …' : ''}`)
    lines.push('Quote specific timestamps when referring to scenes.')
  }
  if (evidence.transcript !== undefined && evidence.transcript.length > 0) {
    lines.push(`Transcript (${evidence.transcript.length}): ${evidence.transcript.slice(0, 6).map((e) => `[${e.t0.toFixed(1)}–${e.t1.toFixed(1)}]${e.speaker !== undefined ? ` ${e.speaker}:` : ''} ${e.text}`).join(' | ')}${evidence.transcript.length > 6 ? ' …' : ''}`)
    lines.push('Quote [t0–t1] ranges and speakers when citing speech.')
  }
  if (evidence.regions !== undefined && evidence.regions.length > 0) {
    lines.push(`Regions (${evidence.regions.length}): ${evidence.regions.slice(0, 8).map((r) => `[${r.kind}] ${r.text.slice(0, 120)}`).join(' | ')}${evidence.regions.length > 8 ? ' …' : ''}`)
    lines.push('Quote region text verbatim.')
  }
  const lastError = lastErrorOf(evidence)
  if (degraded !== undefined && lastError !== undefined) lines.push(`Fallback note: ${lastError}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function mediaToolCard(name: string, rawInput: unknown): { card: 'generic'; title: string; kind: 'execute'; rawInput: string } {
  return {
    card: 'generic',
    title: `${name} ${typeof rawInput === 'string' ? rawInput : String(rawInput ?? '')}`,
    kind: 'execute',
    rawInput: typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput ?? ''),
  }
}
