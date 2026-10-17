/**
 * media-lens 配置：host-only（客户端半身已裁剪）。
 *
 * 处理端选择语义（FR-9）：
 * - `models.{image,audio,video}` = `''` 或 `'auto'` → 按 discovery 枚举的已注册模型自动选；
 * - `'provider/model'` → 显式指定一个宿主已注册模型（视频/音频在宿主模态词表只认
 *   text|image 时，这是把 MiMo 类全模态模型接进链的唯一入口，实际能否承载由
 *   适配器（如 openai-completions 接管线）的模态硬闸把关，拒绝是响亮的）。
 */

export interface MediaLensConfig {
  /** true 时链只含本地 provider（本地 ASR CLI / 本地元数据），媒体内容不出本机。 */
  strictLocalOnly: boolean
  /** 同一 provider 连续失败 ≥2 次后的冷却时长（毫秒）。 */
  cooldownMs: number
  /** 各媒体的处理端选择：'auto' | '' | 'provider/model'。 */
  models: {
    image: string
    audio: string
    video: string
  }
  providers: {
    /** OpenAI-compatible 视觉端点（注册模型缺失/失败时的回退）。 */
    openai: {
      baseUrl: string
      /** 逗号分隔多 key：auth/429/quota 失败时轮换，网络/5xx 跳过保链。 */
      apiKey: string
      model: string
      /** FR-13：开启后注入 response_format json_schema(strict)（不认识的网关会 400，故 opt-in）。 */
      structuredOutput: boolean
    }
    asr: {
      /** 单端点写法的本地转写 CLI 命令模板，{input} 占位。 */
      command: string
      /** 多端点选择项（FR-3/FR-9）：每项一条命令模板，按序尝试。 */
      endpoints: string[]
    }
  }
  /**
   * Phase 7（FR-15）：链出口一次 refine pass——默认关（开启 = 多一跳远端，
   * 多一次媒体内容暴露面）。model 必须显式 `'provider/model'`；`auto` 或空串
   * 均视为未启用（宿主词表封顶 text|image，text 组等价「所有已注册模型」，
   * auto = 随便把所有模型加透镜，禁止）。启用时 refine 失败保 raw + warnings，
   * 不 throw 到链下一级（FR-17）。
   */
  refine: {
    enabled: boolean
    model: string
  }
}

export const DEFAULT_CONFIG: Required<MediaLensConfig> = {
  strictLocalOnly: false,
  cooldownMs: 600_000,
  models: { image: 'auto', audio: 'auto', video: 'auto' },
  providers: {
    openai: { baseUrl: '', apiKey: '', model: '', structuredOutput: false },
    asr: { command: '', endpoints: [] },
  },
  refine: { enabled: false, model: '' },
}

/** 宿主传入的配置形态（schemastery 展开后的全量或部分字段）。 */
export interface MediaLensConfigInput {
  strictLocalOnly?: boolean
  cooldownMs?: number
  models?: Partial<MediaLensConfig['models']>
  providers?: {
    openai?: Partial<MediaLensConfig['providers']['openai']>
    asr?: Partial<MediaLensConfig['providers']['asr']>
  }
  refine?: Partial<MediaLensConfig['refine']>
}

/** 深合并宿主传入的部分配置与默认值（undefined 字段一律回落默认）。 */
export function resolveConfig(partial: MediaLensConfigInput | undefined): Required<MediaLensConfig> {
  const p = partial ?? {}
  const models = { ...DEFAULT_CONFIG.models, ...(p.models ?? {}) }
  const openai = { ...DEFAULT_CONFIG.providers.openai, ...(p.providers?.openai ?? {}) }
  const asr = { ...DEFAULT_CONFIG.providers.asr, ...(p.providers?.asr ?? {}) }
  const refine = { ...DEFAULT_CONFIG.refine, ...(p.refine ?? {}) }
  return {
    strictLocalOnly: p.strictLocalOnly ?? DEFAULT_CONFIG.strictLocalOnly,
    cooldownMs: typeof p.cooldownMs === 'number' && Number.isFinite(p.cooldownMs) && p.cooldownMs >= 0
      ? p.cooldownMs
      : DEFAULT_CONFIG.cooldownMs,
    models: {
      image: models.image ?? DEFAULT_CONFIG.models.image,
      audio: models.audio ?? DEFAULT_CONFIG.models.audio,
      video: models.video ?? DEFAULT_CONFIG.models.video,
    },
    providers: {
      openai: {
        baseUrl: openai.baseUrl ?? '',
        apiKey: openai.apiKey ?? '',
        model: openai.model ?? '',
        structuredOutput: openai.structuredOutput ?? false,
      },
      asr: {
        command: asr.command ?? '',
        endpoints: Array.isArray(asr.endpoints) ? asr.endpoints.filter((e): e is string => typeof e === 'string') : [],
      },
    },
    refine: {
      enabled: refine.enabled === true,
      // 空串与 'auto' 同义（均视为未启用）；'provider/model' 显式选择保留原串。
      model: typeof refine.model === 'string' ? refine.model.trim() : '',
    },
  }
}

/** 解析 `provider/model` 选择串（首个 `/` 分隔）；非显式选择返回 undefined。 */
export function parseModelSelection(value: string | undefined): { provider: string; model: string } | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'auto') return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
}
