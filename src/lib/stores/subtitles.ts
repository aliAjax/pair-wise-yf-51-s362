import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定" | "离线包合并" | "轨道发布";
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
}

export interface TimelineConflict {
  id: string;
  cueId: string;
  message: string;
  remoteStart: number;
  remoteEnd: number;
  status: "待处理" | "采用本地" | "采用协作版本";
}

/** 字幕的历史通过版本：审校通过时留存，术语锁定导致待审失效后仍可查看 */
export interface CueVersion {
  id: string;
  cueId: string;
  version: number;
  source: string;
  translated: string;
  start: number;
  end: number;
  approvedAt: string;
  note: string;
}

/** 离线包：外地组断网译制后回传的轨道包，按轨道 + 字幕标识合并 */
export interface OfflinePackage {
  id: string;
  label: string;
  trackId: string;
  exportedAt: string;
  /** 三方合并基线：离线包导出时的轨道状态 */
  base: Cue[];
  /** 远端回传的字幕状态 */
  cues: Cue[];
  status: "待合并" | "合并中" | "失败" | "已合并";
  /** 断点：已合并的字幕标识，重试时跳过 */
  mergedCueIds: string[];
  conflictIds: string[];
  log: string[];
  error: string;
  attempts: number;
  /** 模拟首次合并时在断点处中断 */
  failAtCueId: string;
}

/** 译文冲突：两边都改过的字幕保留两版，待审校选择 */
export interface CueConflict {
  id: string;
  packageId: string;
  cueId: string;
  reason: string;
  localVersion: { translated: string; status: CueStatus };
  remoteVersion: { translated: string; status: CueStatus };
  status: "待处理" | "采用本地" | "采用远端";
}

const KEY = "pair-wise-yf-51/subtitles-v1";
const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "" },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "" },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "" },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "" }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];
const initial = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
export const cueVersions = writable<CueVersion[]>(initial?.cueVersions ?? []);
export const offlinePackages = writable<OfflinePackage[]>(initial?.packages ?? []);
export const cueConflicts = writable<CueConflict[]>(initial?.cueConflicts ?? []);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({ tracks: get(tracks), cues: get(cues), terms: get(terms), events: get(reviewEvents), snapshots: get(snapshots), cueVersions: get(cueVersions), packages: get(offlinePackages), cueConflicts: get(cueConflicts) }));
}
[tracks, cues, terms, reviewEvents, snapshots, cueVersions, offlinePackages, cueConflicts].forEach((store) => store.subscribe(persist));

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: new Date().toISOString() }, ...items]);
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, ...patch } : cue));
  if (log) event(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { start: Math.max(0, Number((cue.start + delta).toFixed(1))), end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1))) });
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const first = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中" as CueStatus };
  const second = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译" as CueStatus };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : [item]));
  selectedCueId.set(second.id);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中" } : item));
}

export function setCueStatus(id: string, status: CueStatus) {
  updateCue(id, { status });
  const cue = get(cues).find((item) => item.id === id);
  event(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note });
  if (approved) {
    const versions = get(cueVersions).filter((item) => item.cueId === id);
    const version: CueVersion = {
      id: crypto.randomUUID(),
      cueId: id,
      version: versions.length + 1,
      source: cue.source,
      translated: cue.translated,
      start: cue.start,
      end: cue.end,
      approvedAt: new Date().toISOString(),
      note
    };
    cueVersions.update((items) => [version, ...items]);
  }
  event(cue, approved ? "审校通过" : "退回修改", note || cue.translated);
}

/** 术语锁定变化时，待审字幕立即失效并退回重进审校；已通过版本仍可查看 */
function invalidatePendingForTerm(term: GlossaryTerm) {
  const affected = get(cues).filter((cue) => cue.status === "待审" && cue.source.includes(term.source));
  if (!affected.length) return;
  const ids = new Set(affected.map((cue) => cue.id));
  cues.update((items) => items.map((cue) => ids.has(cue.id) ? {
    ...cue,
    status: "退回" as CueStatus,
    reviewerNote: `术语「${term.source}」已锁定为「${term.target}」，待审译文失效，请按术语表更新后重新提交审校。`
  } : cue));
  affected.forEach((cue) => event(cue, "术语锁定", `术语锁定变化，待审字幕失效退回：${cue.source.slice(0, 12)}…`));
}

export function lockTerm(id: string) {
  const term = get(terms).find((item) => item.id === id);
  if (!term || term.status === "已锁定") return;
  terms.update((items) => items.map((item) => item.id === id ? { ...item, status: "已锁定", owner: "术语管理员" } : item));
  invalidatePendingForTerm(get(terms).find((item) => item.id === id)!);
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term.source} → ${term.target}`);
}

/** 修改已锁定术语的目标译文：锁定变化同样触发待审字幕失效 */
export function updateTermTarget(id: string, target: string) {
  const before = get(terms).find((item) => item.id === id);
  if (!before || before.target === target) return;
  terms.update((items) => items.map((item) => item.id === id ? { ...item, target } : item));
  if (before.status === "已锁定") invalidatePendingForTerm(get(terms).find((item) => item.id === id)!);
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) cues.set(structuredClone(snapshot.cues));
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: resolution } : item));
  if (resolution === "采用协作版本") {
    const conflict = get(conflicts).find((item) => item.id === id);
    if (conflict) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
  }
}

function appendPackageLog(packageId: string, line: string) {
  offlinePackages.update((items) => items.map((item) => item.id === packageId ? { ...item, log: [...item.log, line] } : item));
}

function createCueConflict(pkg: OfflinePackage, local: Cue, remote: Cue) {
  const conflict: CueConflict = {
    id: crypto.randomUUID(),
    packageId: pkg.id,
    cueId: local.id,
    reason: "两边都修改了译文，已同时保留本地与远端两版",
    localVersion: { translated: local.translated, status: local.status },
    remoteVersion: { translated: remote.translated, status: remote.status },
    status: "待处理"
  };
  cueConflicts.update((items) => [conflict, ...items]);
  offlinePackages.update((items) => items.map((item) => item.id === pkg.id ? { ...item, conflictIds: [...item.conflictIds, conflict.id] } : item));
}

/** 单条字幕合并：时序以本地为准，译文按三方基线判定，两边都改则保留两版 */
function mergeOneCue(pkg: OfflinePackage, remote: Cue) {
  const base = pkg.base.find((item) => item.id === remote.id);
  const local = get(cues).find((item) => item.id === remote.id);
  if (!local) {
    cues.update((items) => [...items, { ...remote }]);
    appendPackageLog(pkg.id, `字幕 ${remote.id.slice(0, 8)}：远端新增字幕已补入当前轨道`);
    return;
  }
  const localChanged = base ? local.translated !== base.translated : true;
  const remoteChanged = base ? remote.translated !== base.translated : true;
  // 本地已拆并的片段保留现有时序，远端时间码不覆盖
  const patch: Partial<Cue> = { start: local.start, end: local.end };
  const localText = local.translated.trim();
  const remoteText = remote.translated.trim();
  if (!localText && remoteText) {
    patch.translated = remote.translated;
    if (remote.status === "已通过") patch.status = "已通过";
    appendPackageLog(pkg.id, `字幕 ${local.id.slice(0, 8)}：远端新译补入（时序保留本地）`);
  } else if (localText && remoteText && localText !== remoteText) {
    if (localChanged && remoteChanged) {
      createCueConflict(pkg, local, remote);
      patch.status = "待审";
      appendPackageLog(pkg.id, `字幕 ${local.id.slice(0, 8)}：两边都改过译文，已保留两版待审校`);
    } else if (!localChanged && remoteChanged) {
      patch.translated = remote.translated;
      if (remote.status === "已通过") patch.status = "已通过";
      appendPackageLog(pkg.id, `字幕 ${local.id.slice(0, 8)}：采用远端新译文（时序保留本地）`);
    } else {
      appendPackageLog(pkg.id, `字幕 ${local.id.slice(0, 8)}：仅本地修改，保留本地版本`);
    }
  } else {
    appendPackageLog(pkg.id, `字幕 ${local.id.slice(0, 8)}：译文一致，时序保留本地`);
  }
  updateCue(local.id, patch);
}

/** 合并离线包：按轨道 + 字幕标识逐条对接，断点持久化，失败后可从断点重试 */
export function mergeOfflinePackage(packageId: string) {
  const pkg = get(offlinePackages).find((item) => item.id === packageId);
  if (!pkg || pkg.status === "已合并") return;
  offlinePackages.update((items) => items.map((item) => item.id === packageId ? { ...item, status: "合并中", error: "" } : item));
  try {
    const merged = new Set(pkg.mergedCueIds);
    for (const remote of pkg.cues) {
      if (merged.has(remote.id)) continue;
      if (pkg.attempts === 0 && remote.id === pkg.failAtCueId) {
        throw new Error("模拟离线包读取中断：连接在断点处丢失，重试将从断点继续合并");
      }
      mergeOneCue(pkg, remote);
      merged.add(remote.id);
      offlinePackages.update((items) => items.map((item) => item.id === packageId ? { ...item, mergedCueIds: [...merged] } : item));
    }
    offlinePackages.update((items) => items.map((item) => item.id === packageId ? { ...item, status: "已合并" } : item));
    event(undefined, "离线包合并", `离线包「${pkg.label}」合并完成，共同步 ${merged.size} 条字幕`);
  } catch (e) {
    offlinePackages.update((items) => items.map((item) => item.id === packageId ? { ...item, status: "失败", error: (e as Error).message, attempts: item.attempts + 1 } : item));
  }
}

/** 译文冲突处理：保留两版，审校选择采用本地或远端 */
export function resolveCueConflict(id: string, pick: "本地" | "远端") {
  const conflict = get(cueConflicts).find((item) => item.id === id);
  if (!conflict || conflict.status !== "待处理") return;
  if (pick === "远端") updateCue(conflict.cueId, { translated: conflict.remoteVersion.translated, status: "待审" });
  cueConflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: pick === "本地" ? "采用本地" : "采用远端" } : item));
  event(get(cues).find((item) => item.id === conflict.cueId), "离线包合并", `字幕译文冲突已解决：${pick === "本地" ? "保留本地版本" : "采用远端版本"}`);
}

/** 发布轨道：未处理完（有字幕未通过审校或有冲突未解决）则暂不发布 */
export function publishTrack(trackId: string) {
  const track = get(tracks).find((item) => item.id === trackId);
  if (!track) return { ok: false as const, unfinished: [], openConflicts: [] };
  const list = get(cues).filter((item) => item.trackId === trackId);
  const unfinished = list.filter((item) => item.status !== "已通过");
  const openConflicts = get(cueConflicts).filter((conflict) => conflict.status === "待处理" && list.some((item) => item.id === conflict.cueId));
  if (unfinished.length || openConflicts.length) return { ok: false as const, unfinished, openConflicts };
  tracks.update((items) => items.map((item) => item.id === trackId ? { ...item, status: "已通过" as TrackStatus } : item));
  event(undefined, "轨道发布", `轨道「${track.name}」全部字幕已通过审校，正式发布`);
  return { ok: true as const, unfinished: [], openConflicts: [] };
}

/** 查看历史通过版本；可恢复其译文（已通过版本仍可查看） */
export function restoreCueVersion(cueId: string, versionId: string) {
  const version = get(cueVersions).find((item) => item.id === versionId && item.cueId === cueId);
  if (!version) return;
  updateCue(cueId, { translated: version.translated, status: "翻译中", reviewerNote: "" });
  event(get(cues).find((item) => item.id === cueId), "退回修改", `恢复到第 ${version.version} 版通过译文（${version.translated.slice(0, 12)}…）`);
}

/** 生成模拟离线包：以当前轨道为基线，构造远端修订、补译、新增与首次合并中断场景 */
export function makeMockOfflinePackage(trackId: string) {
  const trackCues = get(cues).filter((item) => item.trackId === trackId).sort((a, b) => a.start - b.start);
  if (!trackCues.length) return;
  const base = structuredClone(trackCues);
  const remote = structuredClone(trackCues);
  // 场景1：基线使用旧译文，保证本地与远端都相对基线发生变化 → 两边都改，保留两版
  if (remote[0]) {
    base[0].translated = "（离线基线·旧译文）";
    remote[0].translated = remote[0].translated ? `${remote[0].translated}（外地修订版）` : "外地译员补译版本";
    remote[0].status = "待审";
  }
  // 场景2：远端更新译文并微调时间码 → 采用远端译文，时序保留本地
  if (remote[1]) {
    remote[1].translated = remote[1].translated ? `${remote[1].translated}（外地校订）` : "外地译员补译版本";
    remote[1].end = Number((remote[1].end + 0.4).toFixed(1));
    remote[1].status = "翻译中";
  }
  // 场景3：远端新增字幕，首次合并在该条断点处中断
  const newId = crypto.randomUUID();
  const last = remote[remote.length - 1];
  remote.push({
    id: newId,
    trackId,
    start: last ? Number((last.end + 0.6).toFixed(1)) : 0,
    end: last ? Number((last.end + 3.4).toFixed(1)) : 2.8,
    source: "（远端新增·原文待补）",
    translated: "Remote new subtitle from offline team.",
    status: "待审",
    translator: "外地组",
    reviewerNote: ""
  });
  const trackName = get(tracks).find((item) => item.id === trackId)?.name ?? trackId;
  const pkg: OfflinePackage = {
    id: crypto.randomUUID(),
    label: `${trackName} · 外地组回传包`,
    trackId,
    exportedAt: new Date().toISOString(),
    base,
    cues: remote,
    status: "待合并",
    mergedCueIds: [],
    conflictIds: [],
    log: [],
    error: "",
    attempts: 0,
    failAtCueId: newId
  };
  offlinePackages.update((items) => [pkg, ...items]);
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));
