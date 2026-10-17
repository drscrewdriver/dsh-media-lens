/**
 * failover 链执行（FR-5 + FR-10/11 吸收批语义）：顺序尝试、首个成功即返回、
 * 每跳写 Attempt、全败抛带 attempts 的结构化错误（M5）。
 *
 * 冷却 v2（modlens cooldown.ts 深析）：**只冷 keyFailure 类失败**——普通失败
 * （含正文碰巧含 quota 字样的普通 Error）永不触碰冷却状态；冷却成员**垫队尾**
 * 仍作最后尝试（软化熔断，不是失效剔除）；provider 给恢复线索（Retry-After /
 * "Resets in"）按线索计时，否则 cooldownMs；成功即清冷却。
 * meta.warnings 是人类可读路由通告通道（failover 去向/垫尾/轮换成功）。
 */

import type { Attempt, Chunk, MediaEvidence } from '../evidence.ts'
import { finalizeChunk } from '../evidence.ts'
import type { LensRequest, Provider } from './registry.ts'

/** 冷却判定输入：typed 失败自带（openai-vl MediaVlError），普通错误全 false。 */
export interface FailureInfo {
  keyFailure: boolean
  resetAfterMs?: number | null
}

export function failureInfoOf(err: unknown): FailureInfo {
  const typed = err as { keyFailure?: unknown; resetAfterMs?: unknown }
  return {
    keyFailure: typed?.keyFailure === true,
    resetAfterMs: typeof typed?.resetAfterMs === 'number' ? typed.resetAfterMs : null,
  }
}

/** 轮换型失败携带的逐 key 子尝试（runChain 直接并入 attempts）。 */
export function keyAttemptsOf(err: unknown): Attempt[] | undefined {
  const subs = (err as { keyAttempts?: unknown }).keyAttempts
  return Array.isArray(subs) ? (subs as Attempt[]) : undefined
}

export class AllProvidersFailed extends Error {
  readonly attempts: Attempt[]
  readonly warnings: string[]
  readonly kind: LensRequest['media']

  constructor(kind: LensRequest['media'], attempts: Attempt[], message?: string, warnings: string[] = []) {
    super(message ?? `all providers failed for ${kind} (${attempts.length} attempt${attempts.length === 1 ? '' : 's'})`)
    this.name = 'AllProvidersFailed'
    this.kind = kind
    this.attempts = attempts
    this.warnings = warnings
  }
}

/** keyFailure 冷却闸：一次 typed 失败即入冷却（threshold 概念废除——quota 墙不必撞两次）。 */
export class CooldownGate {
  private readonly until = new Map<string, number>()

  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 只有 keyFailure 计；普通失败 no-op（不计数、不清状态、不延长）。 */
  recordFailure(name: string, info: FailureInfo): void {
    if (info.keyFailure !== true) return
    const ms = typeof info.resetAfterMs === 'number' && info.resetAfterMs > 0 ? info.resetAfterMs : this.cooldownMs
    this.until.set(name, this.now() + ms)
  }

  recordSuccess(name: string): void {
    this.until.delete(name)
  }

  /** true = 可尝试；冷却到期自动恢复（清窗）。 */
  isOpen(name: string): boolean {
    const deadline = this.until.get(name)
    if (deadline === undefined) return true
    if (this.now() >= deadline) {
      this.until.delete(name)
      return true
    }
    return false
  }

  coolingDeadline(name: string): number | undefined {
    return this.isOpen(name) ? undefined : this.until.get(name)
  }
}

export interface ChainRunOptions {
  /**
   * 跨请求共享的冷却闸（工具层持有同一实例）：冷却窗口必须活在单次调用之外。
   */
  gate?: CooldownGate
  cooldownMs?: number
  now?: () => number
  /** 每跳开始/结束的可观测回调（宿主日志）。 */
  log?: (message: string) => void
  /**
   * Phase 7（FR-16）：链出口一次 refine hook——首个成功 chunk finalize 后、
   * return 前调用；未启用时保持 undefined，行为与 Phase 6 逐字段一致（M28）。
   * hook 内部自己判 local 跳过 / selection 非显式 / llm 缺失，失败保 raw +
   * warnings，不 throw 到链下一级（读手已成功）。
   */
  refine?: (evidence: MediaEvidence) => Promise<MediaEvidence>
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 顺序执行链：冷却成员**垫队尾**（stable 重排 + warnings 通告），首个成功即
 * finalize 返回（attempts + warnings 聚合）；链空 → no provider configured；
 * 单成员链穷尽 → 保留原始可行动错误；多成员穷尽 → AllProvidersFailed。
 */
export async function runChain(
  chain: Provider[],
  req: LensRequest,
  options: ChainRunOptions = {},
): Promise<MediaEvidence> {
  const gate = options.gate ?? new CooldownGate(options.cooldownMs ?? 600_000, options.now)
  const attempts: Attempt[] = []
  const warnings: string[] = []

  if (chain.length === 0) {
    throw new AllProvidersFailed(req.media, attempts, `no provider configured for ${req.media}`)
  }

  // FR-10 垫队尾：冷却成员排到最后仍被尝试（穷途时仍试一把），不是跳过。
  const open = chain.filter((p) => gate.isOpen(p.name))
  const cooling = chain.filter((p) => !gate.isOpen(p.name))
  if (cooling.length > 0) {
    for (const provider of cooling) {
      const deadline = gate.coolingDeadline(provider.name)
      const until = deadline !== undefined ? new Date(deadline).toISOString() : '?'
      warnings.push(`${provider.name} is cooling until ${until}, so it moves to the back of the chain.`)
    }
  }
  const ordered = [...open, ...cooling]

  let lastError: unknown
  for (const provider of ordered) {
    const started = options.now?.() ?? Date.now()
    try {
      const chunk: Chunk = await provider.run(req)
      const ms = Math.max(0, (options.now?.() ?? Date.now()) - started)
      const failed = attempts.filter((a) => !a.ok)
      attempts.push({
        provider: provider.name,
        ...(chunk.meta.keyIndex !== undefined ? { keyIndex: chunk.meta.keyIndex } : {}),
        ok: true,
        ms,
      })
      gate.recordSuccess(provider.name)
      if (failed.length > 0) {
        const rotated = failed.every((a) => a.provider === provider.name) && chunk.meta.keyIndex !== undefined
        warnings.push(
          rotated
            ? `Rotated to ${provider.name} API key ${(chunk.meta.keyIndex ?? 0) + 1} after earlier keys failed.`
            : `Failed over to ${provider.name} after: ${failed.map((a) => `${a.provider}: ${a.error ?? 'failed'}`).join(' | ')}.`,
        )
      }
      const finalized = finalizeChunk(chunk, attempts, warnings)
      if (options.refine === undefined) return finalized
      try {
        return await options.refine(finalized)
      } catch (err) {
        // refine hook 本身不应 throw（内部已保 raw），这一层兑个底：异常仍保 raw。
        options.log?.(`[media-lens] refine hook threw: ${err instanceof Error ? err.message : String(err)}`)
        return finalized
      }
    } catch (err) {
      const ms = Math.max(0, (options.now?.() ?? Date.now()) - started)
      lastError = err
      const subs = keyAttemptsOf(err)
      if (subs !== undefined && subs.length > 0) {
        attempts.push(...subs)
      } else {
        attempts.push({ provider: provider.name, ok: false, error: errorText(err).slice(0, 300), ms })
      }
      gate.recordFailure(provider.name, failureInfoOf(err))
      options.log?.(`[media-lens] provider ${provider.name} failed: ${errorText(err)}`)
    }
  }

  // 单成员链穷尽：原始错误本身可行动（指引换 key/端点），不被聚合错误吞掉。
  if (chain.length === 1 && lastError instanceof Error) {
    throw lastError
  }
  throw new AllProvidersFailed(req.media, attempts, undefined, warnings)
}
