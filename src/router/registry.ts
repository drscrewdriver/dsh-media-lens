/**
 * provider 注册表（FR-5）：每媒体一条链，链序 = 注册序（调用方按 FR 顺序注册：
 * registered/multimodal → configured → local）。strictLocalOnly 过滤远端成员。
 */

import type { Chunk, MediaKind } from '../evidence.ts'
import type { BudgetDecision } from './budget.ts'

export interface FrameRef {
  /** 帧在原视频里的时间（秒）。 */
  t: number
  /** 抽出的帧图片绝对路径。 */
  path: string
}

export interface LensRequest {
  /** 原始媒体绝对路径。 */
  path: string
  sizeBytes: number
  durationSec?: number
  media: MediaKind
  budget: BudgetDecision
  /** 用户/模型的额外关注点，透传给处理端。 */
  instruction?: string
  /** 抽帧路（video 走图片链）的帧清单。 */
  frames?: FrameRef[]
}

export interface Provider {
  /**
   * 链内标识，带来源前缀（M19）：`registered:<provider>/<model>` /
   * `multimodal:<provider>/<model>` / `configured:openai` / `asr:<name>` /
   * `frames:<inner>` / `local:metadata`。
   */
  readonly name: string
  /** 声明能处理的媒体种类。 */
  readonly media: readonly MediaKind[]
  /** 是否把媒体内容发往本机之外（strictLocalOnly 过滤依据）。 */
  readonly remote: boolean
  /** 运行时可用性（服务缺失 / 未配置 key / 冷却之外的动态门槛）。 */
  available(): boolean
  /** signal：调用方取消（vision-bridge 请求改写随宿主请求中止）；工具层可不传。 */
  run(req: LensRequest, signal?: AbortSignal): Promise<Chunk>
}

export class ProviderRegistry {
  private readonly providers: Provider[] = []

  register(provider: Provider): void {
    this.providers.push(provider)
  }

  /** 链 = 注册序中声明处理该媒体且可用的成员；strictLocalOnly 时剔除远端。 */
  chainFor(kind: MediaKind, strictLocalOnly: boolean): Provider[] {
    return this.providers.filter(
      (p) => p.media.includes(kind) && (!strictLocalOnly || !p.remote) && p.available(),
    )
  }
}
