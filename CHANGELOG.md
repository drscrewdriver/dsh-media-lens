# Changelog

0.2.2: host enumeration addendum for DSH 0.2.1-rc.3 (declaration-only bump; contract plane zero diff).

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

## 0.2.0 (2026-10-23)

vision-bridge 发布版：选择器可见的透镜包装 + 配置热生效根因修复 + 宿主三线全 rc 支持。以下批次随本版首发（modlens / provider pair 两批原标注 0.1.0 同版本并入，npm 0.1.0 未含，实际随本版出）。

### modlens 源码吸收批（2026-10-06 深析，随 0.2.0 首发）
- 冷却语义升级（FR-10）：仅 keyFailure 类失败触发冷却，普通失败永不冷却（正文碰巧含 quota 字样不算）；冷却 provider **垫队尾**仍作最后尝试（软化熔断，非踢出）；`Retry-After` 头 / `Resets in Xh Ym Zs` 解析进冷却时长；成功即恢复。
- attempts 带 `keyIndex`（多 key 轮换可见）；`meta.warnings` 人类可读路由通告（failover 去向、冷却垫尾、轮换成功）；错误文本先脱密（apiKey/baseUrl 精确匹配）再截断（redact-before-clip）。
- 证据合同 v2：新增 `uncertainty?: string[]`（模型自报读不清处，宁标不猜）；可选字段 null 归一（不拒整读）；处理指令带反注入行（媒体内指令视为数据）、verbatim 转写行、bbox 保守措辞。
- 传输硬化：请求显式 `stream: false`（网关缺省分歧）；`providers.openai.structuredOutput` opt-in 注入 strict json_schema（由证据载荷派生，非手写镜像）；`finish_reason=length` 截断判因（与形状问题区分）。
- 入参 magic-byte sniff（FR-14）：png/jpeg/gif/webp/bmp、ftyp/EBML、RIFF/ID3/fLaC/OggS/ADTS/ASF 头字节判型，改名伪装文件在入参侧拒绝。
- 单成员链穷尽保留原始可行动错误（不被聚合错误吞掉）。

### provider pair 吸收批 v2（2026-10-17，链出口 refine pass，随 0.2.0 首发）
- 新增顶层配置 `refine: { enabled, model }`（FR-15，opt-in 默认关）：开启后主链首个成功 → `finalizeChunk` 之后 → return 之前过一次可选文本模型（对齐 medialens 型项目 "读手 + 转述手" pair）。model 必须显式 `'provider/model'`；`auto` / 空串 = 未启用（宿主 text 组 = 所有已注册模型，auto = 随便加透镜）。
- refine 失败保 raw（FR-17）：LLM throw / JSON 解析失败 / validateEvidence 不通过 三情形均不 throw 到链下一级，仅追 `meta.warnings` 一条 `refine failed: <redacted>`；主链 attempts 不新增（读手已成功，不浪费下一跳抽帧/ASR）。
- refine 归属分层（FR-19）：`MediaEvidence.meta` 新增 `refineAttempt?: Attempt`，`provider = 'refined:<selection>'`；`meta.provider` 保留读手前缀（registered/multimodal/configured/asr/frames/local）；source/attempts/generatedAt/degraded 不被 refine 修改。
- 指令硬化（FR-18）：`EVIDENCE_REFINE_INSTRUCTION` 与读手 EVIDENCE_INSTRUCTION 同四要素（反注入/verbatim/bbox 保守/uncertainty），另加「保留原 source 与 attempts，不新增媒体路径信息」一行——防洗证据（raw evidence 内媒体指令会二次进入 LLM 上下文）。
- local 兑底（FR-19）：`meta.provider === 'local:metadata'` 或 `meta.degraded === 'local-metadata-only'` 时自动跳过 refine，无文本可精炼；守 strictLocalOnly 用户的隐私默认（“关了远端却被 refine 拉回远端”不允许）。
- 传输硬化（FR-19）：错误路径先 `redactSecrets` 后截断（对齐 M23）；`structuredOutput` 开关共享，ctx.llm.stream 不接 response_format（宿主 GenerateOptions 无该字段），指令层 STRICT JSON 兑住。
- 新文件 `src/refine.ts`（导出 `refineEvidence` + `EVIDENCE_REFINE_INSTRUCTION`）；`router/failover.ts` `ChainRunOptions` 新可选 `refine` hook；工具层从 `LensDeps.refineFn` 取闭包传入 runChain（hook 抛异常时 failover 兑底，仍保 raw）。

### refine-source-gate 吸收批 v3（2026-10-21，转述手来源闸门，随 0.2.0 首发）
- **来源闸门（转述手只认用户自配端点）**：refine 传输从 `ctx.llm.stream`（宿主 runtime 路由表，无法区分宿主原生注册与插件注入模型）改为 **configured 直连**（`callVlWithRotation`，够不到任何注入面）。新增 `isTrustedRefineProvider(endpoint, provider)`：provider 名白名单（`openai`）+ 凭据存在性（baseUrl+apiKey 非空）双判据（`src/config.ts`）。
- **静默跳过语义**：selection 解析出 `registered:` / `multimodal:` / 未知 provider，或 configured 凭据未配齐 → 原样返回 evidence，不写 `refineAttempt`、不追 warning（守 M28「关时逐字段一致」，与 llm 缺失/非显式 selection 现有跳过路径同构）。
- **归一与单源**：裸 model（无 slash）归一为 configured 白名单 `openai`（S1）；请求 model 取 `providers.openai.model` 单源，不采纳 selection 的 model 段；`refineAttempt.provider` 统一 `refined:openai/<model>`，`meta.provider` 仍留读手前缀。
- **传输硬化继承**：直连后 `structuredOutput` 真正注入 `response_format`（顺带修复 v2 中 ctx.llm.stream 注不进去的已知缺陷）；多 key 轮换 keyIndex 透传 `refineAttempt`；错误先脱密后截断不变。
- 工程：`tests/refine.test.ts` 改写为 fetch mock 直连断言（18 例：G1 真值表 / 闸门静默跳过 / 直连 URL 与请求体 / structuredOutput 两态 / 失败保 raw / runChain 集成），全量 105 vitest 用例绿 + lint 零错 + `check:line OK`。

### vision-bridge 吸收批 v4（2026-10-22，选择器可见的透镜包装）
- **包装 provider 注入**：新增配置 `inject: { enabled, families }`（默认关；families 默认 `['deepseek','glm','mimo']`，`'*'` = 全部）。开启后经宿主 `llm.registerAdapter` 注册包装路由 `media-lens-vision-<upstream>`，模型选择器出现 `<模型名> (media-lens vision)` 条目（provider 组名 `<上游名> (media-lens)`）；选中它作主对话模型，请求中的媒体先经透镜转证据文本再委托真实路由。
- **包装判据（用户裁定）= 透镜能补模态就包，omni 坚决不包**：纯文本模型 → 图像+音视频全部证据化；图像模型（声明 image、非 omni）→ 图像块原样透传（保留原生视觉），仅音视频证据化；omni（MiMo bare 非 `-pro` 段名字启发式）与 vision 专精词表（deepseek-vl / glm-4v / `*vision*` / glm-5.3-flash 等）拒包，`resolveModel` 响亮拒绝并指路原路由。
- **请求改写管线（0.2.0-rc.2 投影时序实锚）**：宿主在 adapter 收到请求前把 file 块无条件投影成确定性 handle 文本（按 `content.ts:151-158` 精确格式识别、提取只读盘上路径）→ `guardMediaPath`+`decideBudget`+`runChain` 全链 → 证据文本（反注入头 + `evidenceRender` 体）原位替换；image 块按上游实际模态分流。消息改写 copy-on-write（宿主 deep-frozen 不原地改），assistant 消息 `source.provider` 线副本回标上游（保 replay-state / forAdapter 身份检查，durable log 保留 wrapper id）。
- **改写永不 throw**：读手失败按阶段落常量占位文本（线字节稳定，保 provider prefix cache）；证据缓存按块稳定键（`attachmentId` / 盘上路径），成功永久、失败 60s 后重试、LRU 256。
- **生命周期纪律**（modlens dsh/index.js 实证 + 本仓 C2 软读）：`registerAdapter` 结构化探测（缺失即纯工具插件静默降级）；`llm/adapters-updated` 事件驱动重扫（覆盖 llm-pi-ai 类迟注册路由），sweep 串行化防自触发风暴；`DUPLICATE_ADAPTER` 视为让位成功；注册句柄挂 `ctx.effect` 随 fiber 释放；上游消失/不再合格 → wrapper 回收；上游展示名变更 → `handle.replace` 原子重照快照；`imageRequestPricing` 显式 `undefined`（宿主 ≥0.1.2 无条件调用，纯对象必须自带）。
- **防递归（必须）**：discovery 快照 `filterDiscoverySnapshot` 剔除 `media-lens-vision-*` —— wrapper 注册后自己也在宿主注册表里，不剔除则读手 auto 会选中自己的 wrapper 无限递归；工具链 / models-route 候选 / 显式选择共用同一快照，一处过滤全覆盖。
- **信号穿透**：`Provider.run(req, signal?)` + `ChainRunOptions.signal` 全链下传（providers 七处 + frames/reencode 内层透传），桥的改写随宿主请求中止；工具层不传 signal 行为不变。
- **客户端**：设置卡新增「视觉桥」节（enabled 勾选 + families 逗号分隔输入，中英逗号皆收）；9 语 locale；configForms mutate/set 六路径提交。
- 工程：`tests/inject.test.ts` 23 例（判据真值表 / handle 精确识别 / 改写 copy-on-write 与回标与透传分流 / 缓存成功永久失败重试 LRU / sweep 注册刷新回收 / 桥端到端 读手→证据→委托→缓存命中 / 失败常量占位 / discovery 自排除）；全量 128 vitest 用例绿 + typecheck/lint 零错。

### volatile 活读修复批 v4.1（2026-10-22 深夜，配置热生效根因修复）
- **根因（0.2.0-rc.2 宿主源码实锚）**：宿主对 `.volatile()` 字段传给插件的是带 `.get()` 的活引用（settings/plainConfig、agent-default-model `config.provider.get()` 实证），且写入后**只发 `loader/volatile-update` 事件、不重跑 apply**（llm-pi-ai / llm-deepseek / speech-to-text 三内置插件同范式自证）。media-lens 原先在 apply 期把 config 平铺展开——cell 被展开成垃圾属性，**全部字段静默回落默认值**：不仅视觉桥开关无效，处理端模型 / 端点 / refine 等所有用户配置宿主半区从未读到（v4 之前即存在的隐性缺陷，v4 的选择器开关使其显形）。
- **修复**：`resolveConfig` 入口 `detachConfigCells` 递归取直（duck-type `.get()`，照 models-route 软读纪律，不引 cosmokit）；apply 内 `resolved` 改为可整体重算的 `let`，全部闭包（vlConfig / selectionFor / strictLocalOnly / refineFn / bridge families+enabled）调用期解引用即热生效；订阅 `loader/volatile-update`（duck-type）→ 重算 resolved + `bridge.sweep()`（桥按新 enabled 注册/回收包装路由）。已知留置：cooldownMs 变更仍需重载（CooldownGate 构造期取值，重建会丢冷却状态，权衡不改）。
- 工程：`tests/inject.test.ts` 增 3 例（cell 形态 resolveConfig 取直 / 活值重算 / 普通对象照旧），全量 131 vitest 用例绿 + typecheck/lint 零错。

### 宿主三线全 rc 枚举批（2026-10-23，用户裁定口径）
- **口径变更（用户裁定）**：engines.dsh / peers 枚举从「每线一个 farm 保留 rc」改为 **0.1.7 / 0.2.0 / 0.2.1 三线全 rc 枚举**（`0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2`，alpha/beta 不入列）。新增 `0.1.7-rc.1` 与 `0.2.0-rc.1` 两格。
- **契约面核实（tarball 逐字 diff，钉 npmjs）**：`0.2.0-rc.1` llm 类型与 rc.2 **零差异**；`0.1.7-rc.1` attachment 全类型零差异、llm 仅缺本插件不消费的 `toolHistory`/`toolUpdate` 可选面，`registerAdapter` / `llm/adapters-updated` 在位（vision-bridge 在该线可用）。六宿主子包 × 两 rc 共 12 项 npm 在位逐一实查。
- `hosts.mjs` 口径段重写（声明枚举与 farm 实测账本 `.compat-results/verified.json` 分属两档，后者不动），`sync-hosts --write` 三写点下发。
- 全门禁：131 vitest 用例绿 + typecheck/lint 零错。

### 宿主 0.2.1-rc.2 支持批（2026-10-23，engines 枚举补格 + wrapper 直调面补齐）
- **背景**：desktop 宿主 manifest 推荐 rc 已是 0.2.1-rc.2；engines.dsh 自 0.2.1-alpha.4 起是独立且优先的拒载判据，枚举不含 rc.2 则宿主升级即拒载本插件。
- **契约面核实（tarball 逐字 diff，0.2.1-rc.2 vs 0.2.0-rc.2）**：`dsh-attachment` 全类型文件零差异；`dsh-llm` message/content/retry-policy 零差异，index/types 仅**可选**新增（adapter 面 `imageRequestTarget`、runtime 面 `prepareCall(config, signal?, configure?)`——adapter 面签名不变、directory 侧 `LlmConfigurableProvider` 三可选字段）。六宿主子包 npm 全在位（钉 npmjs 实查）。
- **修复**：wrapper adapter 补 `imageRequestTarget`（0.2.1-rc.1 起新增，runtime **直调无 optional chaining**，`lib/index.js:2064` 实锚——纯对象缺了在图像投影时 TypeError；照基类缺省语义原样保留归一化图像 `{width,height,maxBytes}`）。`hosts.mjs` 枚举加 `0.2.1-rc.2`，`sync-hosts --write` 下发 package.json / dsh.plugin.json / README 三写点。
- **verified.json 不动**：rc.2 未过 farm 逐格实测，仅静态 diff + 冒烟级核实（诚实档位）；farm 补测后另行入账。
- 工程：sweep 测试增 adapter 直调面断言（pricing undefined / target 保留语义），全量 131 vitest 用例绿 + typecheck/lint 零错。

### 工程
- 宿主 service 全部 `ctx.get()` 软读优雅降级（C2）；运行时依赖仅 schemastery。
- 131 vitest 用例全绿（含 `tests/inject.test.ts` 26 例覆盖 vision-bridge 与 volatile 取直）；`check:line` 门禁保证 lib/ 与 src/ 逐字节对齐（C3）。
- 宿主线钉三线全 rc：`0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2`（engines.dsh / peerDependencies / dsh.plugin.json / README 四写点由 sync-hosts 单源下发；publishConfig.tag = dsh-0.2.0）。

## 0.2.1 (2026-10-23)

### Changed
- **声明配合姊妹插件**：将两个配合插件加入 `peerDependencies` 并标 `optional`（`dsh-thinking-levels >=4.4.4`、`dsh-llm-openai-completions >=0.4.4`）——多模态模型注册/认证与音视频直传靠它们接管（thinking-levels 管模型配置录入/接管登记，openai-completions 做 OpenAI-compatible 传输接管将 file 块序列化成 video_url/input_audio）。二者均为 optional peer，不装则相应能力自动降级不报错，不触发 npm 强制拉装、不与宿主版本闸门冲突（两包 latest engines.dsh 均已含 0.2.1-rc.2）。README 新增「配合插件」小节。

