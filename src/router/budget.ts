/**
 * 预算裁决（FR-6）：超限不硬拒，沿 full → reencode → sampleFrames / segment /
 * downsample 自动降级。分档先例来自 dsh-video-read 的 10/19MB（OC 内联 20MB
 * 留余量）——该插件是残留工具，仅作预算数字参考（findings 兄弟资产节）。
 */

import type { MediaKind } from '../evidence.ts'

export type BudgetDecision = 'full' | 'reencode' | 'sampleFrames' | 'segment' | 'downsample'

/** 视频直传软上限：超过则先重编码再直传。 */
export const VIDEO_SOFT_BYTES = 10 * 1024 * 1024
/** 视频直传硬上限（OC 内联 20MB 留余量）：超过则放弃直传，改均匀抽帧。 */
export const VIDEO_HARD_BYTES = 19 * 1024 * 1024
/** 视频直传时长上限：超过则抽帧（长视频抽帧比整段直传更省也更准）。 */
export const VIDEO_MAX_SEC = 600
/** 音频单段转写上限：超过或不可探测时标记 segment（由 CLI 自身分割能力消化）。 */
export const AUDIO_SEGMENT_SEC = 30 * 60
/** 图片送视觉端点的软上限：超过则先降采样。 */
export const IMAGE_SOFT_BYTES = 8 * 1024 * 1024

export function decideVideo(sizeBytes: number, durationSec: number | undefined): BudgetDecision {
  if (durationSec !== undefined && durationSec > VIDEO_MAX_SEC) return 'sampleFrames'
  if (sizeBytes > VIDEO_HARD_BYTES) return 'sampleFrames'
  if (sizeBytes > VIDEO_SOFT_BYTES) return 'reencode'
  return 'full'
}

export function decideAudio(durationSec: number | undefined): BudgetDecision {
  if (durationSec === undefined || durationSec > AUDIO_SEGMENT_SEC) return 'segment'
  return 'full'
}

export function decideImage(sizeBytes: number): BudgetDecision {
  if (sizeBytes > IMAGE_SOFT_BYTES) return 'downsample'
  return 'full'
}

export function decideBudget(media: MediaKind, sizeBytes: number, durationSec: number | undefined): BudgetDecision {
  if (media === 'video') return decideVideo(sizeBytes, durationSec)
  if (media === 'audio') return decideAudio(durationSec)
  return decideImage(sizeBytes)
}
