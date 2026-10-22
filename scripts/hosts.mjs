/**
 * hosts.mjs —— 宿主版本枚举的**唯一事实源**。
 *
 * 枚举口径（2026-10-23 用户裁定，替代旧「farm 保留场删红留绿」口径）：0.1.7 /
 * 0.2.0 / 0.2.1 三条支持线**全 rc 枚举**（逐线逐 rc 单列，alpha/beta 不入列）。
 * 升级流程：本数组加版本 → `node scripts/sync-hosts.mjs --write` → 契约面核实
 * （tarball diff + npm 在位，如实记录档位）→ farm 逐格 add+smoke 转绿 → 发版。
 * farm 实测账本在 .compat-results/verified.json，与本枚举分属两档（声明 vs 实测）。
 * 本数组与由它生成的声明（package.json peerDependencies / package.json
 * engines.dsh / dsh.plugin.json engines.dsh）**禁止手改**——0.2.1-alpha.4 起装载
 * 闸门把 engines.dsh 当独立且优先的拒载判据（peers 被忽略），故 engines.dsh 与
 * 全部 dsh-* peer 必须携带同一份精确枚举串，禁止宽区间 / caret 代替。
 */

/** 全部声明支持的宿主 rc（冻结；新增只在此处追加，逐 rc 单列）。 */
export const supportedHosts = Object.freeze([
  // 0.1.7 线（rc.1 契约面核实 2026-10-23：attachment 全零差异，llm 仅缺本插件
  // 不消费的 toolHistory/toolUpdate 可选面，registerAdapter/adapters-updated 在位）
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  // 0.2.0 线（rc.1 llm 类型与 rc.2 逐字零差异）
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  // 0.2.1 线（alpha/beta 不入列）；rc.2 = desktop manifest 推荐 rc（2026-10-23 补，
  // 契约面 diff：adapter 面逐法核对仅新增 imageRequestTarget 直调，wrapper 已补）
  '0.2.1-rc.1',
  '0.2.1-rc.2',
])

/** peerDependencies / engines.dsh 共用的枚举串（精确枚举无暗坑）。 */
export const peerRange = supportedHosts.join(' || ')

/** 本地开发基线（devDependencies 引入的宿主包一律钉这里）。 */
export const developmentHost = '0.2.0-rc.2'

/**
 * peer 闸门指向的宿主子包：本插件为纯服务端 cordis 插件，消费的宿主契约面是
 * tools / llm / attachments 三包（四线经 npm view 逐一核实在位；0.2.1-rc.2 另经
 * tarball 逐字 diff：attachment 全零差异，llm 仅 directory 侧可选新增）。运行时
 * 闸门把**每个** dsh-* peer 对着宿主运行时版本做全枚举匹配，故三分包一律全枚举，
 * 不做按代拆分。
 * peer 为**必需**（非 optional）：本插件无独立 CLI，只在宿主 profile 内装载，
 * 装机走 autoInstallPeers:false + hoisted，peer 从不进 registry。
 * `@deepseek-ai/cordis` 不在此列：它不随宿主线走，单独保留 `^4.0.2` 必需。
 */
export const hostPeerPackages = Object.freeze([
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
])

/**
 * 客户端半身消费的宿主 client 包（0.1.7+ 起有；三线经 npm view 逐一核实在位）。
 * 作为 **optional** peer：宿主 profile 装载时由 autoInstallPeers:false + hoisted
 * 提供，从不进 registry；独立 npm 安装不强制拉装。同串精确枚举（白名单语义）。
 */
export const clientHostPeers = Object.freeze([
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-slots',
])
