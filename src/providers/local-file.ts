/**
 * strict local-only 兜底（FR-7）：只产出 probe 元数据证据（时长/分辨率/大小），
 * 明确 degraded='local-metadata-only'，让模型知道"只有元数据，别装作看过内容"。
 */

import { basename } from 'node:path'
import type { Chunk } from '../evidence.ts'
import { makeChunk } from '../evidence.ts'
import type { LensRequest, Provider } from '../router/registry.ts'
import { probe } from './ffmpeg.ts'

export function createLocalFileProvider(): Provider {
  return {
    name: 'local:metadata',
    media: ['video', 'audio', 'image'],
    remote: false,
    available: () => true,
    async run(req: LensRequest): Promise<Chunk> {
      const probed = await probe(req.path)
      const source = {
        path: req.path,
        sizeBytes: probed.sizeBytes,
        ...(probed.durationSec !== undefined ? { durationSec: probed.durationSec } : {}),
        ...(probed.resolution !== undefined ? { resolution: probed.resolution } : {}),
      }
      const summary = [
        `${req.media} "${basename(req.path)}"`,
        probed.sizeBytes > 0 ? `${(probed.sizeBytes / (1024 * 1024)).toFixed(2)} MB` : undefined,
        probed.durationSec !== undefined ? `${probed.durationSec.toFixed(1)}s` : undefined,
        probed.resolution !== undefined ? `${probed.resolution[0]}x${probed.resolution[1]}` : undefined,
      ].filter((part) => part !== undefined).join(', ')
      const chunk: Chunk = makeChunk({
        kind: req.media,
        source,
        timeline: [{ t: 0, text: `Metadata only: ${summary}. Content was not analyzed (local-only mode or all providers exhausted).` }],
        meta: { provider: 'local:metadata', degraded: 'local-metadata-only' },
      })
      return chunk
    },
  }
}
