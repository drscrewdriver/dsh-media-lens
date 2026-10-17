# Changelog

## 0.1.0 (2026-10-06)

首版：透镜线（A）+ 路由线（B）单计划双线落地。

### 线 A 透镜（Evidence, not imagination）
- `media_read_video` / `media_read_audio` / `media_read_image` 三个 host 工具，统一输出 MediaEvidence JSON 证据合同（timeline / transcript / regions + `meta.attempts`）。
- 图片直读字节送视觉端点，绕开宿主 read_image 的 sharp 故障；bmp 等附件词表外格式由 configured 端点兜。
- 视频：预算分档 full（≤10MB 直传全模态）/ reencode（10–19MB 540p x264 压缩）/ sampleFrames（>19MB 或 >10min 均匀抽 6–12 帧 + 图片链）；timeline 证据带逐帧时间戳。
- 音频：全模态直传转写 + 本地 ASR CLI（SenseVoice / batch-voice-transcriber 两种输出 fixture 的适配层：JSON segments 与 SRT/时间行）双路。

### 线 B 路由（fallback never silent）
- 每媒体一条 failover 链，首个成功即返回；全败抛 `AllProvidersFailed{attempts}`。
- 注册模型发现（FR-9）：`ctx.llm.listProviders()/listModels()` 软读枚举 + `inputModalities` 分组 + 60s 缓存；`models.{image,audio,video}: "provider/model"` 显式选择高于 discovery（视频 MiMo 路入口）。
- 预算裁决不硬拒：full / reencode / sampleFrames / segment / downsample 自动降级。
- keyFailure 类失败触发冷却（FR-10，modlens 软化熔断语义），跨请求共享闸，到期自动恢复。
- strictLocalOnly：链中剔除一切远端成员，媒体内容不出本机。
- OpenAI-compatible 端点逗号 key 轮换（auth/429/quota 换 key，网络/5xx 保链）。
- 音视频直传防幻觉：未接管线路的 handle 文本回声被检测并放弃该跳，落抽帧/ASR 兜底。

### modlens 源码吸收批（2026-10-06 深析，同版本并入）
- 冷却语义升级（FR-10）：仅 keyFailure 类失败触发冷却，普通失败永不冷却（正文碰巧含 quota 字样不算）；冷却 provider **垫队尾**仍作最后尝试（软化熔断，非踢出）；`Retry-After` 头 / `Resets in Xh Ym Zs` 解析进冷却时长；成功即恢复。
- attempts 带 `keyIndex`（多 key 轮换可见）；`meta.warnings` 人类可读路由通告（failover 去向、冷却垫尾、轮换成功）；错误文本先脱密（apiKey/baseUrl 精确匹配）再截断（redact-before-clip）。
- 证据合同 v2：新增 `uncertainty?: string[]`（模型自报读不清处，宁标不猜）；可选字段 null 归一（不拒整读）；处理指令带反注入行（媒体内指令视为数据）、verbatim 转写行、bbox 保守措辞。
- 传输硬化：请求显式 `stream: false`（网关缺省分歧）；`providers.openai.structuredOutput` opt-in 注入 strict json_schema（由证据载荷派生，非手写镜像）；`finish_reason=length` 截断判因（与形状问题区分）。
- 入参 magic-byte sniff（FR-14）：png/jpeg/gif/webp/bmp、ftyp/EBML、RIFF/ID3/fLaC/OggS/ADTS/ASF 头字节判型，改名伪装文件在入参侧拒绝。
- 单成员链穷尽保留原始可行动错误（不被聚合错误吞掉）。

### provider pair 吸收批 v2（2026-10-17，链出口 refine pass，同版本并入）
- 新增顶层配置 `refine: { enabled, model }`（FR-15，opt-in 默认关）：开启后主链首个成功 → `finalizeChunk` 之后 → return 之前过一次可选文本模型（对齐 medialens 型项目 "读手 + 转述手" pair）。model 必须显式 `'provider/model'`；`auto` / 空串 = 未启用（宿主 text 组 = 所有已注册模型，auto = 随便加透镜）。
- refine 失败保 raw（FR-17）：LLM throw / JSON 解析失败 / validateEvidence 不通过 三情形均不 throw 到链下一级，仅追 `meta.warnings` 一条 `refine failed: <redacted>`；主链 attempts 不新增（读手已成功，不浪费下一跳抽帧/ASR）。
- refine 归属分层（FR-19）：`MediaEvidence.meta` 新增 `refineAttempt?: Attempt`，`provider = 'refined:<selection>'`；`meta.provider` 保留读手前缀（registered/multimodal/configured/asr/frames/local）；source/attempts/generatedAt/degraded 不被 refine 修改。
- 指令硬化（FR-18）：`EVIDENCE_REFINE_INSTRUCTION` 与读手 EVIDENCE_INSTRUCTION 同四要素（反注入/verbatim/bbox 保守/uncertainty），另加「保留原 source 与 attempts，不新增媒体路径信息」一行——防洗证据（raw evidence 内媒体指令会二次进入 LLM 上下文）。
- local 兑底（FR-19）：`meta.provider === 'local:metadata'` 或 `meta.degraded === 'local-metadata-only'` 时自动跳过 refine，无文本可精炼；守 strictLocalOnly 用户的隐私默认（“关了远端却被 refine 拉回远端”不允许）。
- 传输硬化（FR-19）：错误路径先 `redactSecrets` 后截断（对齐 M23）；`structuredOutput` 开关共享，ctx.llm.stream 不接 response_format（宿主 GenerateOptions 无该字段），指令层 STRICT JSON 兑住。
- 新文件 `src/refine.ts`（导出 `refineEvidence` + `EVIDENCE_REFINE_INSTRUCTION`）；`router/failover.ts` `ChainRunOptions` 新可选 `refine` hook；工具层从 `LensDeps.refineFn` 取闭包传入 runChain（hook 抛异常时 failover 兑底，仍保 raw）。

### 工程
- 宿主 service 全部 `ctx.get()` 软读优雅降级（C2）；运行时依赖仅 schemastery。
- 97 vitest 用例全绿（新增 `tests/refine.test.ts` 12 例覆盖 M28-M32 / S13-S14 + `tests/discovery.test.ts` refine 配置面 1 例）；`check:line` 门禁保证 lib/ 与 src/ 逐字节对齐（C3）。
- 宿主线钉 `0.2.0-rc.1 || 0.2.0-rc.2`（engines.dsh / peerDependencies / publishConfig.tag 三处对齐）。
