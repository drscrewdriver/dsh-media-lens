/**
 * media-lens 客户端设置卡（全量可编辑表单）。
 * 数据面：宿主 configForms 权威 scope（0.1.7+/0.2.0/0.2.1 唯一活写路径）。
 * 编辑模型：**本地缓冲 + 失焦提交**——输入框由组件本地 state 驱动，可自由输入/清空，
 *   仅在 blur（或回车）时把该字段写回宿主；避免「每击键写 + 快照回灌」导致删不干净、
 *   以及原生 datalist 在非空时不弹候选的问题。外部快照变化（提交落定/重置）时再回填本地。
 * 配色：一律走宿主主题令牌 --dsw-alias-*（禁写死颜色，暗色壳不炸白控件）。
 * 渲染降级：scope 不可用（status!=='ready' 或 !writable）→ 只读展示 + 提示，绝不 throw。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, CSSProperties, KeyboardEvent } from 'react'
import type { MediaLensConfig } from '../config.ts'
import { DEFAULT_CONFIG } from '../config.ts'

/** 卡片消费的最小 scope 面（由 client/index.ts 的 configForms 臂提供）。 */
export interface LensScope {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => { status: string; value?: MediaLensConfig; writable?: boolean }
  /** 写入完整 settings 文档（configForms 权威写）。 */
  commit: (next: MediaLensConfig) => Promise<boolean>
}

export interface LensCardProps {
  scope: LensScope
  t: (key: string) => string
}

const surface = 'var(--dsw-alias-bg-surface, rgba(127,127,127,0.12))'
const labelColor = 'var(--dsw-alias-label-primary, inherit)'
const hintColor = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.7))'

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 12, color: labelColor, maxWidth: 560 }
const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }
const input: CSSProperties = { background: surface, color: labelColor, border: '1px solid rgba(127,127,127,0.25)', borderRadius: 6, padding: '6px 8px', font: 'inherit' }
const heading: CSSProperties = { fontWeight: 600, marginTop: 4 }
const hint: CSSProperties = { color: hintColor, fontSize: 12 }

interface BufferedTextProps {
  label: string
  value: string
  onCommit: (next: string) => void
  disabled: boolean
  listId?: string
  options?: string[]
  placeholder?: string
}

/** 文本字段：本地缓冲，blur/回车提交；datalist 候选（可空时弹全部）。 */
function BufferedText({ label, value, onCommit, disabled, listId, options, placeholder }: BufferedTextProps) {
  const [local, setLocal] = useState(value)
  useEffect(() => { setLocal(value) }, [value]) // 外部快照变化（提交落定/重置）回填本地
  const commit = useCallback(() => { if (local !== value) onCommit(local) }, [local, value, onCommit])
  return (
    <label style={row}>
      <span style={hint}>{label}</span>
      <input
        style={input} type="text" value={local} list={listId} disabled={disabled} placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
      {listId !== undefined ? (
        <datalist id={listId}>{(options ?? []).map((opt) => <option key={opt} value={opt} />)}</datalist>
      ) : null}
    </label>
  )
}

/** 数字字段：本地缓冲，blur/回车提交。 */
function BufferedNumber({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (n: number) => void; disabled: boolean }) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => { setLocal(String(value)) }, [value])
  const commit = useCallback(() => {
    const n = Number(local)
    if (Number.isFinite(n) && n >= 0 && Math.round(n) !== value) onCommit(Math.round(n))
    else setLocal(String(value))
  }, [local, value, onCommit])
  return (
    <label style={row}>
      <span style={hint}>{label}</span>
      <input
        style={input} type="number" min={0} value={local} disabled={disabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
    </label>
  )
}

/** 布尔字段：即时提交（无打字过程，不受缓冲问题影响）。 */
function Check({ label, value, onCommit, disabled }: { label: string; value: boolean; onCommit: (v: boolean) => void; disabled: boolean }) {
  return (
    <label style={{ ...row, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e: ChangeEvent<HTMLInputElement>) => onCommit(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function MediaLensSettingsCard({ scope, t }: LensCardProps) {
  const snap = useSyncExternalStore(scope.subscribe, scope.getSnapshot)
  const value: MediaLensConfig = snap.value ?? structuredClone(DEFAULT_CONFIG)
  const editable = snap.status === 'ready' && (snap.writable ?? false)

  // 已注册模型候选（宿主 /api/dsh-media-lens/models）；拉不到则只留 'auto'，字段仍为自由文本框。
  const [candidates, setCandidates] = useState<{ image: string[]; audio: string[]; video: string[] }>({
    image: ['auto'], audio: ['auto'], video: ['auto'],
  })
  useEffect(() => {
    let alive = true
    fetch('/api/dsh-media-lens/models', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { groups?: { image?: Array<{ value?: string }>; audio?: Array<{ value?: string }>; video?: Array<{ value?: string }> }; all?: Array<{ value?: string }> } | null) => {
        if (!alive || j?.groups === undefined) return
        const uniq = (arr: string[]): string[] => Array.from(new Set(arr.filter((v) => v !== '')))
        const allVals = (j.all ?? []).map((m) => m.value ?? '')
        const mk = (arr?: Array<{ value?: string }>): string[] => ['auto', ...uniq([...(arr ?? []).map((m) => m.value ?? ''), ...allVals])]
        setCandidates({ image: mk(j.groups.image), audio: mk(j.groups.audio), video: mk(j.groups.video) })
      })
      .catch(() => { /* 无路由/失败：保持纯文本框 */ })
    return () => { alive = false }
  }, [])

  // 单字段提交：克隆当前快照文档、改该字段、整份写回（configForms 权威）。
  const patch = useCallback(
    (mut: (draft: MediaLensConfig) => void): void => {
      const draft: MediaLensConfig = structuredClone(value)
      mut(draft)
      void scope.commit(draft)
    },
    [scope, value],
  )

  return (
    <div style={box}>
      {snap.status === 'loading' ? <div style={hint}>{t('loading')}</div> : null}
      {!editable && snap.status !== 'loading' ? <div style={hint}>{t('readonly')}</div> : null}

      <div style={heading}>{t('privacyTitle')}</div>
      <Check label={t('strictLocalOnly')} value={value.strictLocalOnly} disabled={!editable} onCommit={(v) => patch((d) => { d.strictLocalOnly = v })} />
      <div style={hint}>{t('strictLocalOnlyHint')}</div>

      <BufferedNumber label={t('cooldownMs')} value={value.cooldownMs} disabled={!editable} onCommit={(n) => patch((d) => { d.cooldownMs = n })} />

      <div style={heading}>{t('modelsTitle')}</div>
      <div style={hint}>{t('modelsHint')}</div>
      <div style={grid}>
        <BufferedText label={t('image')} value={value.models.image} disabled={!editable} listId="mlens-models-image" options={candidates.image} onCommit={(v) => patch((d) => { d.models.image = v })} />
        <BufferedText label={t('audio')} value={value.models.audio} disabled={!editable} listId="mlens-models-audio" options={candidates.audio} onCommit={(v) => patch((d) => { d.models.audio = v })} />
        <BufferedText label={t('video')} value={value.models.video} disabled={!editable} listId="mlens-models-video" options={candidates.video} onCommit={(v) => patch((d) => { d.models.video = v })} />
      </div>

      <div style={heading}>{t('openaiTitle')}</div>
      <BufferedText label={t('baseUrl')} value={value.providers.openai.baseUrl} disabled={!editable} placeholder="https://api.example.com/v1" onCommit={(v) => patch((d) => { d.providers.openai.baseUrl = v })} />
      <BufferedText label={t('apiKey')} value={value.providers.openai.apiKey} disabled={!editable} onCommit={(v) => patch((d) => { d.providers.openai.apiKey = v })} />
      <BufferedText label={t('model')} value={value.providers.openai.model} disabled={!editable} onCommit={(v) => patch((d) => { d.providers.openai.model = v })} />
      <Check label={t('structuredOutput')} value={value.providers.openai.structuredOutput} disabled={!editable} onCommit={(v) => patch((d) => { d.providers.openai.structuredOutput = v })} />

      <div style={heading}>{t('asrTitle')}</div>
      <BufferedText label={t('command')} value={value.providers.asr.command} disabled={!editable} onCommit={(v) => patch((d) => { d.providers.asr.command = v })} />
      <span style={hint}>{t('endpoints')}</span>
      {value.providers.asr.endpoints.map((cmd, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <BufferedText label="" value={cmd} disabled={!editable} onCommit={(v) => patch((d) => { d.providers.asr.endpoints[i] = v })} />
          </div>
          <button style={input} disabled={!editable} onClick={() => patch((d) => { d.providers.asr.endpoints.splice(i, 1) })}>{t('removeEndpoint')}</button>
        </div>
      ))}
      <button style={input} disabled={!editable} onClick={() => patch((d) => { d.providers.asr.endpoints.push('') })}>{t('addEndpoint')}</button>

      <div style={heading}>{t('refineTitle')}</div>
      <Check label={t('refineEnabled')} value={value.refine.enabled} disabled={!editable} onCommit={(v) => patch((d) => { d.refine.enabled = v })} />
      <BufferedText label={t('refineModel')} value={value.refine.model} disabled={!editable} placeholder="provider/model" onCommit={(v) => patch((d) => { d.refine.model = v })} />

      <div style={heading}>{t('injectTitle')}</div>
      <Check label={t('injectEnabled')} value={value.inject.enabled} disabled={!editable} onCommit={(v) => patch((d) => { d.inject.enabled = v })} />
      <div style={hint}>{t('injectEnabledHint')}</div>
      <BufferedText
        label={t('injectFamilies')}
        value={value.inject.families.join(', ')}
        disabled={!editable}
        placeholder="deepseek, glm, mimo"
        onCommit={(v) => patch((d) => { d.inject.families = v.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '') })}
      />
      <div style={hint}>{t('injectFamiliesHint')}</div>
    </div>
  )
}
