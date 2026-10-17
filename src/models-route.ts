/**
 * 已注册模型候选路由（设置卡下拉数据源）：
 * `GET /api/dsh-media-lens/models`（及 /endpoint 变体）→ 当前 discovery 快照按模态分组，
 * 供客户端把「处理端模型」字段渲染成可选候选（保留自由文本显式指定）。
 *
 * 注册纪律照 context-compression settings-bridge：webServer 软读 + ctx.inject 双通道、
 * exact 路由、ctx.effect 释放；宿主无 webServer 时静默缺席（卡片回落纯文本框）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DiscoverySnapshot } from './discovery.ts'

interface WebServerLike {
  register(route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void
}

interface ResLike {
  writeHead: (code: number, headers?: Record<string, string>) => void
  end: (body?: string) => void
}

function asWebServer(value: unknown): WebServerLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return typeof (value as { register?: unknown }).register === 'function' ? (value as WebServerLike) : undefined
}

/** 快照 → 精简候选（只暴露 provider/id/name，不外泄其余运行时字段）。 */
function serialize(snapshot: DiscoverySnapshot): unknown {
  const pick = (list: DiscoverySnapshot['groups']['image']) =>
    list.map((m) => ({ provider: m.provider, id: m.id, name: m.name, value: `${m.provider}/${m.id}` }))
  return {
    ok: true,
    available: snapshot.available,
    groups: { image: pick(snapshot.groups.image), audio: pick(snapshot.groups.audio), video: pick(snapshot.groups.video) },
    // 全部已注册模型：宿主元数据常不声明 inputModalities（模态组多为空），
    // 而显式 `provider/model` 选择本就被尊重，故候选集以全量为主。
    all: pick(snapshot.models),
  }
}

export function wireModelsRoute(ctx: Context, getSnapshot: () => DiscoverySnapshot, log: (message: string) => void): void {
  const handler = (_req: unknown, res: unknown): void => {
    const typed = res as ResLike | undefined
    if (typeof typed?.writeHead !== 'function' || typeof typed?.end !== 'function') return
    try {
      typed.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
      typed.end(JSON.stringify(serialize(getSnapshot())))
    } catch (error) {
      typed.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      typed.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  let registered = false
  const register = (webServer: WebServerLike): void => {
    if (registered) return
    try {
      const disposers = ['/endpoint/dsh-media-lens/models', '/api/dsh-media-lens/models']
        .map((path) => webServer.register({ kind: 'exact', path, handler }))
        .filter((off): off is () => void => typeof off === 'function')
      registered = true
      ctx.effect(() => () => { for (const off of disposers) off() }, 'media-lens: registered-model candidates route')
      log('[media-lens] registered-model candidates route mounted')
    } catch (error) {
      log(`[media-lens] models route registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const active = asWebServer((() => { try { return ctx.get('webServer') } catch { return undefined } })())
  if (active !== undefined) { register(active); if (registered) return }
  ctx.inject(['webServer'], (injected) => {
    const webServer = asWebServer((injected as { webServer?: unknown }).webServer)
    if (webServer !== undefined) register(webServer)
  })
}
