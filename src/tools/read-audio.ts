/**
 * media_read_audio（FR-3）：音频双路 —— 全模态模型直传（multimodal）→
 * ASR 端点选择项（asr-shell，多端点按序）→ local:metadata 兜底。
 * 输出转写证据（时间戳规整 t0 ≤ t1 + 可选说话人）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runChain } from '../router/failover.ts'
import type { CooldownGate } from '../router/failover.ts'
import type { LensDeps } from './chains.ts'
import { buildAudioChain } from './chains.ts'
import { buildLensRequest } from './tool-kit.ts'
import { evidenceRender, mediaToolCard } from './render.ts'

export function createReadAudioTool(deps: LensDeps, gate: CooldownGate, log: (m: string) => void) {
  return defineTool({
    name: 'media_read_audio',
    description:
      'Transcribe a local audio file (wav/mp3/m4a/flac/ogg/opus/aac/wma) into timestamped, speaker-attributable transcript evidence. ' +
      'Tries a registered omni-modal model first, then configured ASR CLI endpoints. ' +
      'Call automatically whenever the user mentions an audio file path. Supports an optional focus instruction.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path (or path relative to the session directory) of the audio file.' },
      instruction: { type: 'string', description: 'Optional focus, e.g. "who actioned these decisions" or "extract action items".' },
    },
    output: {
      schema: { type: 'json' },
      render: evidenceRender,
    },
    async execute(args, exec) {
      const req = await buildLensRequest(args, 'audio', exec.agent?.session?.header?.cwd)
      log(`media_read_audio ${basename(req.path)} budget=${req.budget}`)
      const refine = deps.refineFn?.()
      return (await runChain(buildAudioChain(deps), req, { gate, log, ...(refine !== undefined ? { refine } : {}) })) as unknown as JsonValue
    },
    presentCall: (argsValue) => mediaToolCard('media_read_audio', argsValue['path']),
  })
}
