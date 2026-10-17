/**
 * media_read_video（FR-2）：处理端 = 注册 MiMo 类全模态模型优先（multimodal
 * 直传，reencode 档先 540p 压缩）→ 国外全模态（同直传路，经显式选择接入）→
 * ffmpeg 均匀抽帧 + 图片链兜底 → local:metadata。
 * >19MB 或 >10min 直接抽帧；输出 timeline + transcript 证据。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runChain } from '../router/failover.ts'
import type { CooldownGate } from '../router/failover.ts'
import type { LensDeps } from './chains.ts'
import { buildVideoChain } from './chains.ts'
import { buildLensRequest } from './tool-kit.ts'
import { evidenceRender, mediaToolCard } from './render.ts'

export function createReadVideoTool(deps: LensDeps, gate: CooldownGate, log: (m: string) => void) {
  return defineTool({
    name: 'media_read_video',
    description:
      'Analyze a local video (mp4/webm/mov/mkv) and return structured evidence: a scene timeline and, when present, a speech transcript with timestamps. ' +
      'Registered omni-modal models are tried first; long or oversized videos fall back to evenly-sampled frames through vision endpoints. ' +
      'Call automatically whenever the user mentions a video file path. Supports an optional focus instruction.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path (or path relative to the session directory) of the video file.' },
      instruction: { type: 'string', description: 'Optional focus, e.g. "find the moment the error dialog appears".' },
    },
    output: {
      schema: { type: 'json' },
      render: evidenceRender,
    },
    async execute(args, exec) {
      const req = await buildLensRequest(args, 'video', exec.agent?.session?.header?.cwd)
      log(`media_read_video ${basename(req.path)} budget=${req.budget}`)
      const refine = deps.refineFn?.()
      return (await runChain(buildVideoChain(deps, req.budget), req, { gate, log, ...(refine !== undefined ? { refine } : {}) })) as unknown as JsonValue
    },
    presentCall: (argsValue) => mediaToolCard('media_read_video', argsValue['path']),
  })
}
