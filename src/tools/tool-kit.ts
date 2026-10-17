/**
 * 三工具共享的请求构建：守卫路径 → probe → 预算裁决 → LensRequest。
 */

import { probe } from '../providers/ffmpeg.ts'
import { decideBudget } from '../router/budget.ts'
import type { LensRequest } from '../router/registry.ts'
import type { MediaKind } from '../evidence.ts'
import { guardMediaPath } from './path-guard.ts'

export async function buildLensRequest(
  input: { path: string; instruction?: string },
  kind: MediaKind,
  cwd: string | undefined,
): Promise<LensRequest> {
  const guarded = await guardMediaPath(input.path, kind, cwd)
  const probed = await probe(guarded.absPath)
  const budget = decideBudget(kind, guarded.sizeBytes, probed.durationSec)
  return {
    path: guarded.absPath,
    sizeBytes: guarded.sizeBytes,
    ...(probed.durationSec !== undefined ? { durationSec: probed.durationSec } : {}),
    media: kind,
    budget,
    ...(input.instruction !== undefined && input.instruction.trim() !== '' ? { instruction: input.instruction.trim() } : {}),
  }
}
