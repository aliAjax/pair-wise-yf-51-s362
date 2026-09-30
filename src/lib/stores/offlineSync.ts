import { cues, logEventAccess, recomputePublish, terms, tracks } from "./subtitles";
import type { Cue, CueStatus, CueVariant, GlossaryTerm } from "./subtitles";
import { get, writable } from "svelte/store";

/**
 * 离线轨道包（offline bundle）协议
 * 协作组在断网城市译制后带回的包：按轨道 id 和字幕 id 对接。
 */
export interface RemoteCue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  /** 远端所基于的共同祖先修订号；缺失时按全新字幕处理 */
  baseRevision?: number;
}

export interface RemoteTerm {
  id: string;
  source: string;
  target: string;
  status: "建议" | "已锁定";
  revision: number;
}

export interface OfflinePackage {
  packageId: string;
  author: string;
  city: string;
  exportedAt: string;
  baseRevision: number;
  cues: RemoteCue[];
  terms?: RemoteTerm[];
  /** 模拟传输/解包失败的标记，便于演示“合并失败后重试并接着断点” */
  failBeforeTrack?: string;
}

export type MergeItemStatus = "待处理" | "已补入" | "已保留双版" | "已跳过" | "失败";

export interface MergeItem {
  trackId: string;
  cueId: string;
  kind: "远端新译" | "双方修改" | "仅远端改" | "同一版本" | "跨轨新增";
  status: MergeItemStatus;
  detail: string;
}

export interface MergeCheckpoint {
  packageId: string;
  /** 已成功落库的 (trackId,cueId)，失败重试时从断点继续，不重复处理 */
  processed: string[];
  items: MergeItem[];
  startedAt: string;
  updatedAt: string;
  phase: "进行中" | "失败" | "已完成";
  lastError?: string;
}

const CK_KEY = "pair-wise-yf-51/merge-checkpoint-v1";

function loadCheckpoint(): MergeCheckpoint | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CK_KEY);
  return raw ? (JSON.parse(raw) as MergeCheckpoint) : null;
}
function saveCheckpoint(ck: MergeCheckpoint | null) {
  if (typeof localStorage === "undefined") return;
  if (ck) localStorage.setItem(CK_KEY, JSON.stringify(ck));
  else localStorage.removeItem(CK_KEY);
}

function refreshBusy() {
  const ck = loadCheckpoint();
  const ids = ck ? [...new Set(ck.items.filter((i) => i.status === "待处理" || i.status === "失败").map((i) => i.trackId))] : [];
  busyTrackIds.set(ids);
}

/** 存在未完成合并（失败待重试/进行中）的轨道，响应式供发布门禁使用 */
export const busyTrackIds = writable<string[]>([]);

export function getCheckpoint(): MergeCheckpoint | null {
  return loadCheckpoint();
}

export function clearCheckpoint() {
  saveCheckpoint(null);
  refreshBusy();
  recomputePublish(get(busyTrackIds));
}

function toVariant(remote: RemoteCue, origin: "remote", label: string): CueVariant {
  return { label, origin, revision: remote.baseRevision ?? 0, source: remote.source, translated: remote.translated, start: remote.start, end: remote.end, status: remote.status, translator: remote.translator, mergedAt: new Date().toISOString() };
}

/** 远端新译：补到对应字幕标识；本地没有的字幕直接插入对应轨道 */
function applyRemoteCue(local: Cue | undefined, remote: RemoteCue, item: MergeItem, ck: MergeCheckpoint) {
  const list = get(cues);
  if (!local) {
    const cue: Cue = {
      id: remote.id,
      trackId: remote.trackId,
      start: remote.start,
      end: remote.end,
      source: remote.source,
      translated: remote.translated,
      status: remote.status,
      translator: remote.translator,
      reviewerNote: `来自 ${ck.packageId} 离线包`,
      syncBase: { revision: remote.baseRevision ?? 0, source: remote.source, translated: remote.translated, start: remote.start, end: remote.end, status: remote.status },
      variants: [],
      history: []
    };
    cues.set([...list, cue]);
    item.kind = "跨轨新增";
    item.status = "已补入";
    item.detail = `远端新字幕已补入 ${remote.trackId} 轨：${remote.translated.slice(0, 18)}`;
    return cue;
  }

  const base = local.syncBase;
  const localChanged = !base || local.source !== base.source || local.translated !== base.translated || local.start !== base.start || local.end !== base.end;
  const remoteChanged = !base || (base.revision <= (remote.baseRevision ?? 0) && (remote.source !== base.source || remote.translated !== base.translated || remote.start !== base.start || remote.end !== base.end));

  // 本机已拆并的片段（含远端 id 的后继片）保留现有时序：远端未动时序则绝不覆盖
  if (!localChanged && remoteChanged) {
    const next: Cue = {
      ...local,
      source: remote.source,
      translated: remote.translated,
      start: local.start,
      end: local.end,
      status: remote.status,
      translator: remote.translator || local.translator,
      syncBase: { revision: remote.baseRevision ?? base.revision, source: remote.source, translated: remote.translated, start: local.start, end: local.end, status: remote.status }
    };
    cues.update((items) => items.map((c) => (c.id === local.id ? next : c)));
    item.kind = "仅远端改";
    item.status = "已补入";
    item.detail = `远端新译已补入，本机时序 ${local.start}–${local.end}s 保持不变`;
    return next;
  }

  if (localChanged && !remoteChanged) {
    item.kind = "同一版本";
    item.status = "已跳过";
    item.detail = "仅本机修改，远端无新译，保留本机版本";
    return local;
  }

  if (!localChanged && !remoteChanged) {
    item.kind = "同一版本";
    item.status = "已跳过";
    item.detail = "两边内容一致，无需处理";
    return local;
  }

  // 两边都改过：保留两版并存，等待定稿，未处理完前轨道不发布
  const localVariant: CueVariant = { label: "本机版", origin: "local", revision: base?.revision ?? 0, source: local.source, translated: local.translated, start: local.start, end: local.end, status: local.status, translator: local.translator, mergedAt: new Date().toISOString() };
  const remoteVariant = toVariant(remote, "remote", "远端版");
  const next: Cue = {
    ...local,
    // 主视图保留本机译文与本机时序，远端译文收进 variants
    variants: [localVariant, remoteVariant],
    status: local.status === "已通过" ? "已通过" : "待审",
    reviewerNote: `离线包 ${ck.packageId} 中两边都改过，两版并存待定稿`
  };
  cues.update((items) => items.map((c) => (c.id === local.id ? next : c)));
  item.kind = "双方修改";
  item.status = "已保留双版";
  item.detail = `本机与 ${ck.packageId} 都修改了该字幕，已保留两版（本机时序不动）`;
  return next;
}

/** 双版本定稿：选择其中一版，另一版进历史仍可查看；随后进入待审 */
export function resolveVariant(cueId: string, pick: "local" | "remote", note = "") {
  const cue = get(cues).find((c) => c.id === cueId);
  const variants = cue?.variants ?? [];
  const chosen = variants.find((v) => v.origin === pick);
  const dropped = variants.find((v) => v.origin !== pick);
  if (!cue || !chosen) return;
  const history = [...(cue.history ?? [])];
  if (dropped) {
    history.unshift({ id: crypto.randomUUID(), label: dropped.label, reason: `双版本定稿，未采用${dropped.label}（留档可查看）`, savedAt: new Date().toISOString(), variant: dropped });
  }
  const next: Cue = {
    ...cue,
    source: chosen.source,
    translated: chosen.translated,
    // 本地已拆并的片段保留现有时序：选本机版时时序不动；选远端版才采用远端时序
    start: pick === "local" ? cue.start : chosen.start,
    end: pick === "local" ? cue.end : chosen.end,
    translator: chosen.translator,
    status: "待审",
    reviewerNote: note || `双版本已定稿采用${chosen.label}，重新提交审校`,
    variants: [],
    history
  };
  cues.update((items) => items.map((c) => (c.id === cueId ? next : c)));
  logEventAccess(next, "版本保留", `双版本定稿：采用${chosen.label}，另一版已留档`);
  recomputePublish();
}

/** 合并离线包里的术语：高版本锁定覆盖低版本，并触发术语失效流程由调用方处理 */
export function previewRemoteTerms(pack: OfflinePackage): { term: GlossaryTerm; previous?: GlossaryTerm }[] {
  const localTerms = get(terms);
  const out: { term: GlossaryTerm; previous?: GlossaryTerm }[] = [];
  for (const remote of pack.terms ?? []) {
    const previous = localTerms.find((t) => t.id === remote.id);
    if (remote.status === "已锁定" && (!previous || remote.revision > (previous.revision ?? 0))) {
      out.push({ term: { id: remote.id, source: remote.source, target: remote.target, status: "已锁定", owner: "术语管理员", revision: remote.revision, lockedAt: new Date().toISOString() }, previous });
    }
  }
  return out;
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 对接离线包：可反复调用。
 * - 首次：建立检查点（断点），逐条处理；
 * - 失败：检查点落盘，已处理条目不回滚；
 * - 重试：从断点继续，直到整包完成；
 * - 未处理完的轨道保持未发布。
 */
export async function mergeOfflinePackage(pack: OfflinePackage, opts: { onProgress?: (done: number, total: number) => void; signal?: { cancelled: boolean } } = {}): Promise<MergeCheckpoint> {
  let ck = loadCheckpoint();
  if (!ck || ck.packageId !== pack.packageId) {
    const items: MergeItem[] = [];
    const trackIds = [...new Set(pack.cues.map((c) => c.trackId))];
    for (const trackId of trackIds) {
      for (const remote of pack.cues.filter((c) => c.trackId === trackId)) {
        items.push({ trackId, cueId: remote.id, kind: "远端新译", status: "待处理", detail: "等待处理" });
      }
    }
    ck = { packageId: pack.packageId, processed: [], items, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: "进行中" };
    saveCheckpoint(ck);
  } else {
    ck.phase = "进行中";
    ck.lastError = undefined;
    saveCheckpoint(ck);
  }

  refreshBusy(); recomputePublish(get(busyTrackIds));

  const processed = new Set(ck.processed);
  const failGate = pack.failBeforeTrack;
  let reachedGate = false;

  for (let i = 0; i < ck.items.length; i++) {
    const item = ck.items[i];
    if (opts.signal?.cancelled) break;
    if (processed.has(`${item.trackId}:${item.cueId}`) && item.status !== "失败") continue;

    // 模拟断网城市带回的包在某轨道处解包失败：断点前条目已落库，之后原封不动
    if (failGate && item.trackId === failGate && !processed.has(`${item.trackId}:${item.cueId}`)) {
      reachedGate = true;
    }
    if (reachedGate) {
      item.status = "失败";
      item.detail = `解包 ${item.trackId} 轨时网络中断/校验失败，等待重试续传`;
      ck.phase = "失败";
      ck.lastError = `${item.trackId} 轨解包失败`;
      ck.updatedAt = new Date().toISOString();
      saveCheckpoint(ck);
      refreshBusy(); recomputePublish(get(busyTrackIds));
      opts.onProgress?.(processed.size, ck.items.length);
      throw new Error(ck.lastError);
    }

    try {
      const remote = pack.cues.find((c) => c.id === item.cueId && c.trackId === item.trackId)!;
      const local = get(cues).find((c) => c.id === item.cueId && c.trackId === item.trackId);
      const result = applyRemoteCue(local, remote, item, ck);
      processed.add(`${item.trackId}:${item.cueId}`);
      ck.processed = [...processed];
      if (item.status === "已补入" || item.status === "已保留双版") {
        logEventAccess(result, item.status === "已补入" ? "合并导入" : "版本保留", `[${pack.city}/${pack.author}] ${item.detail}`);
      }
      ck.updatedAt = new Date().toISOString();
      saveCheckpoint(ck);
      opts.onProgress?.(processed.size, ck.items.length);
      await delay(120);
    } catch (err) {
      item.status = "失败";
      ck.phase = "失败";
      ck.lastError = err instanceof Error ? err.message : String(err);
      saveCheckpoint(ck);
      refreshBusy(); recomputePublish(get(busyTrackIds));
      throw err;
    }
  }

  // 术语锁定随包到达：高版本锁定先入库（失效联动在 UI 的 applyPackageTerms 中触发）
  ck.phase = "已完成";
  ck.updatedAt = new Date().toISOString();
  saveCheckpoint(ck);
  opts.onProgress?.(ck.processed.length, ck.items.length);
  // 保留检查点供查看，直到用户清除；不再阻塞发布
  refreshBusy(); recomputePublish(get(busyTrackIds));
  const trackNames = get(tracks).filter((t) => new Set(pack.cues.map((c) => c.trackId)).has(t.id)).map((t) => t.name);
  logEventAccess(undefined, "合并导入", `离线包 ${pack.packageId}（${pack.city}）已全部对接完成：${trackNames.join("、")}`, "系统");
  return ck;
}

/** 重试：同一包从断点继续。failBeforeTrack 仅在第一次失败时生效，重试即越过 */
export async function retryMerge(pack: OfflinePackage, opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<MergeCheckpoint> {
  const clean: OfflinePackage = { ...pack, failBeforeTrack: undefined };
  return mergeOfflinePackage(clean, opts);
}

/** 演示用：构造两个“断网城市”带回的离线包 */
export function sampleRemotePackages(): OfflinePackage[] {
  return [
    {
      packageId: "PKG-OSAKA-0930",
      author: "周野",
      city: "大阪",
      exportedAt: new Date().toISOString(),
      baseRevision: 3,
      failBeforeTrack: "ja",
      cues: [
        // en 轨：远端只改译文（远端新译），本机时序必须保留
        { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "When the tide ebbs, the pier resurfaces.", status: "待审", translator: "海外校对-A", baseRevision: 3 },
        // en 轨：两边都改过 → 双版本保留
        { id: "c3", trackId: "en", start: 3.2, end: 6.4, source: "修复组必须在下一场潮水到来前完成加固。", translated: "Crews must reinforce the wharf ahead of the next tide.", status: "待审", translator: "海外校对-A", baseRevision: 3 },
        // ja 轨：远端新译补到已有字幕
        { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引けば、埠頭がまた姿を見せる。", status: "待审", translator: "周野", baseRevision: 3 },
        // ja 轨：本地没有的远端新字幕
        { id: "c5", trackId: "ja", start: 3.4, end: 6.6, source: "修复组必须在下一场潮水到来前完成加固。", translated: "修理班は次の潮が来る前に補強を終えなければならない。", status: "翻译中", translator: "周野", baseRevision: 3 }
      ],
      terms: [
        { id: "g3", source: "加固", target: "shore up", status: "已锁定", revision: 1 }
      ]
    },
    {
      packageId: "PKG-BUSAN-1001",
      author: "韩真",
      city: "釜山",
      exportedAt: new Date().toISOString(),
      baseRevision: 3,
      cues: [
        // 术语再升级：码头 pier → dock（rev 3），触发已通过/待审字幕失效
        { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide falls, the dock emerges once more.", status: "待审", translator: "韩真", baseRevision: 3 }
      ],
      terms: [
        { id: "g2", source: "码头", target: "dock", status: "已锁定", revision: 3 }
      ]
    }
  ];
}
