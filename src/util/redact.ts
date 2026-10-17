/**
 * FR-11（modlens 吸收）：错误文本脱密。纪律是 **redact-before-clip**——
 * 先做精确匹配抹除、再截断；顺序反了截断边界会落在密钥中间，精确匹配
 * 就再也找不到它了（modlens openaiCompat.ts 的 review 教训）。
 */

/** 抹除 text 中出现的每一个 secret（精确匹配）；空/非串 secret 忽略。 */
export function redactSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    out = out.split(secret).join('[redacted]')
  }
  return out
}
