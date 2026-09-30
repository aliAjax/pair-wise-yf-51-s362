# pair-wise-yf-51 多语言字幕翻译和时间轴协作编辑器

源提示词摘要：制作人建立原语言和多语言字幕轨，译员拆分、合并、移动字幕并维护时间码，审校人员处理术语、超长文本、上下文备注和冲突版本；系统提供术语锁定、审校退回、版本快照、键盘连续操作和导出预览。

## 离线协作合并规则

- **按轨道和字幕标识对接离线包**：离线包（`OfflinePackage`）携带 `trackId/cueId`、基线修订号（`baseRevision`）、译文与时间码。
- **本地已拆并片段保留现有时序**：每条字幕带 `syncBase` 三方共同祖先；仅远端改译文时补入译文但本机 `start/end` 不动；拆分子片继承父条基线。
- **两边都改过保留两版**：合并为 `variants: [本机版, 远端版]`，主视图保留本机时序，定稿前该字幕阻塞发布；定稿时未采用的一版自动进 `history` 留档。
- **未处理完的轨道暂不发布**：发布门禁检查双版本、未走完审校的字幕、进行中/失败待重试的合并；已发布轨道重新出现阻塞项会自动下架。
- **失败可重试并接着断点**：合并检查点（`localStorage: merge-checkpoint-v1`）记录已落库条目，失败后 `retryMerge` 从断点继续，不重复处理。
- **术语锁定变化联动**：高版本锁定（含离线包带入的）入库后，待审/翻译中字幕立即置为「失效重审」并把失效前版本留档；已通过版本不撤审，只打过期标记，可随时在历史中查看或重开修订。

核心代码：`src/lib/stores/subtitles.ts`（状态与术语/发布规则）、`src/lib/stores/offlineSync.ts`（离线包协议、三方合并、断点续并）。

## 验证

```bash
node scripts/smoke-merge.mjs   # 六条合并语义冒烟用例
npm run check                  # 类型检查
npm run build
```

## 技术栈

SvelteKit、TypeScript、Skeleton UI、Svelte stores、TanStack Query、Superforms、Zod、Paraglide。

## 本地运行

```bash
npm install
npm run dev
npm run build
```

开发端口：62016

页面内置两个演示离线包（大阪包首次合并在 ja 轨模拟失败，可体验断点续并；釜山包带入 `码头 → dock` 的 rev.3 锁定，可体验术语失效重审）。

