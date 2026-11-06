/**
 * media_read_pdf：PDF 证据包裹 —— 注册模型 file 块直传（multimodal 路唯一成员，
 * openai-completions 接管线按 extraInputs 的 `pdf` 声明模态放行并序列化成
 * OpenAI `file` part；未接管的线路宿主投影 handle 文本，直传回执按无证据
 * 处理并落到 local:metadata 兜底）。输出版面 regions 证据（页/节/表/图）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runChain } from '../router/failover.ts'
import type { CooldownGate } from '../router/failover.ts'
import type { LensDeps } from './chains.ts'
import { buildPdfChain } from './chains.ts'
import { buildLensRequest } from './tool-kit.ts'
import { evidenceRender, mediaToolCard } from './render.ts'

export function createReadPdfTool(deps: LensDeps, gate: CooldownGate, log: (m: string) => void) {
  return defineTool({
    name: 'media_read_pdf',
    description:
      'Analyze a local PDF document and return structured evidence: sections, tables and figures as region entries with verbatim text. ' +
      'The document is sent natively (OpenAI file part) to a registered PDF-capable model; when none is reachable only probe metadata is returned. ' +
      'Call automatically whenever the user mentions a PDF file path. Supports an optional focus instruction.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path (or path relative to the session directory) of the PDF file.' },
      instruction: { type: 'string', description: 'Optional focus, e.g. "extract the pricing table" or "summarize section 3".' },
    },
    output: {
      schema: { type: 'json' },
      render: evidenceRender,
    },
    async execute(args, exec) {
      if (!deps.modalityEnabled('pdf')) {
        throw new Error('media-lens: PDF evidence wrapping is disabled by the modality switch in the plugin settings (modalities.pdf = false)')
      }
      const req = await buildLensRequest(args, 'pdf', exec.agent?.session?.header?.cwd)
      log(`media_read_pdf ${basename(req.path)} budget=${req.budget}`)
      const refine = deps.refineFn?.()
      return (await runChain(buildPdfChain(deps), req, { gate, log, ...(refine !== undefined ? { refine } : {}) })) as unknown as JsonValue
    },
    presentCall: (argsValue) => mediaToolCard('media_read_pdf', argsValue['path']),
  })
}
