/**
 * FR-13（modlens 吸收）：structuredOutput opt-in。
 * OpenAiVlConfig 也住这里（openai-vl 与 payload schema 同源，防漂移）。
 *
 * 纪律（modlens issue #37）：认识的网关开 strict json_schema 能显著提证据质量；
 * 不认识的网关对未知 response_format 字段直接 400 —— 所以**只能 opt-in**，
 * 缺省不发。strict schema 由基础载荷 schema 派生（全 required + 可空化 +
 * additionalProperties:false），派生而非手写，两者永不漂移。
 */

export interface OpenAiVlConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** true 时请求注入 response_format json_schema(strict)。默认 false。 */
  structuredOutput?: boolean
}

export interface JsonSchemaNode {
  type?: string
  properties?: Record<string, JsonSchemaNode>
  required?: readonly string[]
  items?: JsonSchemaNode
  enum?: readonly string[]
  description?: string
  anyOf?: JsonSchemaNode[]
  additionalProperties?: boolean
}

/**
 * 证据载荷基础 schema：向模型要的形状（source/meta 由插件补，不向模型要）。
 * bbox 保留但指令层要求"能定位才给"（模型倾向编造坐标——modlens 干脆删字段，
 * 本插件保留可选位，靠指令与 null 归一双闸）。
 */
export const EVIDENCE_PAYLOAD_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: { t: { type: 'number' }, text: { type: 'string' } },
        required: ['t', 'text'],
      },
    },
    transcript: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t0: { type: 'number' },
          t1: { type: 'number' },
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['t0', 't1', 'text'],
      },
    },
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bbox: { type: 'array', items: { type: 'number' } },
          text: { type: 'string' },
          kind: { type: 'string' },
        },
        required: ['text', 'kind'],
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
  },
  required: [],
}

/**
 * OpenAI structured-output 严格化：每个属性进 required，非必需的包成
 * anyOf[strict, null]（strict 模式没有可选属性，只有可空属性），
 * additionalProperties:false 一路压平。
 */
export function strictSchema(node: JsonSchemaNode): JsonSchemaNode {
  if (node.type === 'object') {
    const properties: Record<string, JsonSchemaNode> = {}
    const required = node.required ?? []
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const strict = strictSchema(child)
      properties[key] = required.includes(key)
        ? strict
        : { anyOf: [strict, { type: 'null' }] }
    }
    return {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }
  }
  if (node.type === 'array' && node.items !== undefined) {
    return { ...node, items: strictSchema(node.items) }
  }
  return node
}

/** OpenAI `response_format` 值。 */
export function evidenceResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'media_evidence_payload',
      strict: true,
      schema: strictSchema(EVIDENCE_PAYLOAD_SCHEMA),
    },
  }
}
