/**
 * media_read_image（FR-4）：图片直接读字节送视觉处理端，绕开宿主 read_image
 * 的 sharp 故障。链：registered image → configured:openai → local:metadata。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runChain } from '../router/failover.ts'
import type { CooldownGate } from '../router/failover.ts'
import type { LensDeps } from './chains.ts'
import { buildImageChain } from './chains.ts'
import { buildLensRequest } from './tool-kit.ts'
import { evidenceRender, mediaToolCard } from './render.ts'

export function createReadImageTool(deps: LensDeps, gate: CooldownGate, log: (m: string) => void) {
  return defineTool({
    name: 'media_read_image',
    description:
      'Read a local image (jpg/jpeg/png/webp/gif/bmp) and return structured visual evidence: reading-order text regions, entities, and layout as quotable JSON. ' +
      'Bypasses the host read_image decoder. Call automatically whenever the user mentions an image file path. ' +
      'Supports an optional focus instruction.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path (or path relative to the session directory) of the image file.' },
      instruction: { type: 'string', description: 'Optional focus, e.g. "extract the table" or "list every error code".' },
    },
    output: {
      schema: { type: 'json' },
      render: evidenceRender,
    },
    async execute(args, exec) {
      const req = await buildLensRequest(args, 'image', exec.agent?.session?.header?.cwd)
      log(`media_read_image ${basename(req.path)} budget=${req.budget}`)
      const refine = deps.refineFn?.()
      return (await runChain(buildImageChain(deps), req, { gate, log, ...(refine !== undefined ? { refine } : {}) })) as unknown as JsonValue
    },
    presentCall: (argsValue) => mediaToolCard('media_read_image', argsValue['path']),
  })
}
