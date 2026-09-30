import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回" | "失效重审";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
  /** 已发布的轨道导出给外部使用；存在未合并/未定稿内容时自动下架 */
  published: boolean;
}

/** 与远端共同祖先（base）对齐用的快照，离线包中会一并带走 */
export interface SyncBase {
  revision: number;
  source: string;
  translated: string;
  start: number;
  end: number;
  status: CueStatus;
}

export interface CueVariant {
  label: string;
  origin: "local" | "remote";
  revision: number;
  source: string;
  translated: string;
  start: number;
  end: number;
  status: CueStatus;
  translator: string;
  mergedAt?: string;
}

export interface CueHistoryEntry {
  id: string;
  label: string;
  reason: string;
  savedAt: string;
  variant: CueVariant;
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
  /** 三方合并的共同祖先；本地拆分出的新片段继承父条基线 */
  syncBase?: SyncBase;
  /** 两边都改过时并存的两版，定稿前阻塞发布 */
  variants?: CueVariant[];
  /** 历次留档（含已通过版本、失效前版本），随时可查看 */
  history?: CueHistoryEntry[];
  /** 术语锁定变化后，已通过版本打上的过期标记（不影响查看） */
  termStale?: boolean;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
  revision: number;
  lockedAt?: string;
}

export type ReviewAction =
  | "提交审校"
  | "审校通过"
  | "退回修改"
  | "术语锁定"
  | "合并导入"
  | "版本保留"
  | "术语失效"
  | "发布"
  | "拆分合并";

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: ReviewAction;
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

const KEY = "pair-wise-yf-51/subtitles-v1";
const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过", published: true },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中", published: false },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿", published: false }
];

function baseOf(c: Omit<Cue, "syncBase" | "history" | "variants" | "termStale">, revision: number): SyncBase {
  return { revision, source: c.source, translated: c.translated, start: c.start, end: c.end, status: c.status };
}

const seedCuesRaw = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过" as CueStatus, translator: "系统", reviewerNote: "" },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审" as CueStatus, translator: "林岚", reviewerNote: "" },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中" as CueStatus, translator: "林岚", reviewerNote: "" },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译" as CueStatus, translator: "周野", reviewerNote: "" }
];
const seedCues: Cue[] = seedCuesRaw.map((c) => ({ ...c, syncBase: baseOf(c, 3), history: [] }));
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", revision: 2, lockedAt: "2026-09-20T09:00:00.000Z" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", revision: 2, lockedAt: "2026-09-20T09:00:00.000Z" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚", revision: 0 }
];

interface Persisted {
  tracks?: Track[];
  cues?: Cue[];
  terms?: GlossaryTerm[];
  events?: ReviewEvent[];
  snapshots?: Snapshot[];
}
const raw: Persisted | null = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;

/** 旧版本存档补齐新增字段，避免刷新后状态异常 */
function migrateCue(cue: Cue): Cue {
  return {
    ...cue,
    history: cue.history ?? [],
    variants: cue.variants ?? [],
    termStale: cue.termStale ?? false,
    syncBase: cue.syncBase ?? baseOf(cue, 3)
  };
}
function migrateTerm(term: GlossaryTerm, index: number): GlossaryTerm {
  return { ...term, revision: term.revision ?? (term.status === "已锁定" ? 2 : 0), lockedAt: term.lockedAt };
}

export const tracks = writable<Track[]>(raw?.tracks?.map((t) => ({ ...t, published: t.published ?? false })) ?? seedTracks);
export const cues = writable<Cue[]>((raw?.cues ?? seedCues).map(migrateCue));
export const terms = writable<GlossaryTerm[]>((raw?.terms ?? seedTerms).map(migrateTerm));
export const reviewEvents = writable<ReviewEvent[]>(raw?.events ?? []);
export const snapshots = writable<Snapshot[]>(raw?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({ tracks: get(tracks), cues: get(cues), terms: get(terms), events: get(reviewEvents), snapshots: get(snapshots) }));
}
[tracks, cues, terms, reviewEvents, snapshots].forEach((store) => store.subscribe(persist));

export function resetDemo() {
  tracks.set(structuredClone(seedTracks));
  cues.set(structuredClone(seedCues));
  terms.set(structuredClone(seedTerms));
  reviewEvents.set([]);
  snapshots.set([]);
  conflicts.set([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
  activeTrackId.set("en");
  selectedCueId.set("c2");
}

function logEvent(cue: Cue | undefined, action: ReviewAction, detail: string, actor?: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: actor ?? get(reviewer), time: new Date().toISOString() }, ...items]);
}
/** 供离线合并等模块复用的审校日志入口 */
export const logEventAccess = logEvent;

function archive(cue: Cue, label: string, reason: string, variant: CueVariant): CueHistoryEntry {
  return { id: crypto.randomUUID(), label, reason, savedAt: new Date().toISOString(), variant };
}

function cueVariant(cue: Cue, label: string, origin: CueVariant["origin"], revision: number): CueVariant {
  return { label, origin, revision, source: cue.source, translated: cue.translated, start: cue.start, end: cue.end, status: cue.status, translator: cue.translator };
}

const CONTENT_KEYS: (keyof Cue)[] = ["source", "translated", "start", "end"];
function touchesContent(patch: Partial<Cue>) {
  return CONTENT_KEYS.some((key) => patch[key] !== undefined);
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  let archived: Cue | undefined;
  cues.update((items) => items.map((cue) => {
    if (cue.id !== id) return cue;
    // 已通过版本在被改动前先留档，之后仍可随时查看
    if (cue.status === "已通过" && touchesContent(patch)) {
      const entry = archive(cue, "已通过版本", "通过后再次编辑，自动留档", cueVariant(cue, "已通过版本", "local", cue.syncBase?.revision ?? 0));
      archived = cue;
      cue = { ...cue, history: [entry, ...(cue.history ?? [])], termStale: false };
    }
    return { ...cue, ...patch };
  }));
  if (archived) logEvent(archived, "审校通过", "已通过版本已留档，可在字幕历史中查看");
  if (log) logEvent(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
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
  // 已在本机拆并的片段保留现有时序与基线，远端包按字幕标识对接时不会被整段盖掉
  const first: Cue = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中", variants: [] };
  const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译", variants: [], history: [], termStale: false };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : item));
  selectedCueId.set(second.id);
  logEvent(cue, "拆分合并", `在 ${middle}s 处拆分为两条，沿用父条基线 rev.${cue.syncBase?.revision ?? 0}`);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中" } : item));
  logEvent(current, "拆分合并", `与下一条 ${next.id} 合并，保留本机时序 ${current.start}–${next.end}s`);
}

export function setCueStatus(id: string, status: CueStatus) {
  cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, status, termStale: status === "待审" ? false : cue.termStale } : cue));
  const cue = get(cues).find((item) => item.id === id);
  logEvent(cue, status === "待审" ? "提交审校" : status === "失效重审" ? "术语失效" : "退回修改", cue?.translated ?? "");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  if (approved) {
    // 通过即定稿：双版本状态清空，术语过期标记清除；旧版本仍在 history 中
    updateCue(id, { status: "已通过", reviewerNote: note, variants: [], termStale: false });
  } else {
    updateCue(id, { status: "退回", reviewerNote: note });
  }
  const latest = get(cues).find((item) => item.id === id);
  logEvent(latest, approved ? "审校通过" : "退回修改", note || latest?.translated || "");
}

/** 已通过但术语过期的字幕重新打开修订，通过版本先进历史留档 */
export function reopenCue(id: string, reason: string) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  const entry = archive(cue, "已通过版本", reason, cueVariant(cue, "已通过版本", "local", cue.syncBase?.revision ?? 0));
  cues.update((items) => items.map((item) => item.id === id ? { ...item, status: "翻译中", termStale: false, reviewerNote: reason, history: [entry, ...(item.history ?? [])] } : item));
  logEvent(cue, "退回修改", reason);
}

/**
 * 术语锁定发生变化（新增锁定或修改锁定译文）：
 * - 待审/翻译中且引用该术语的字幕立即失效，重进审校，失效前版本留档可查看；
 * - 已通过版本不撤审，只打过期标记，可随时打开历史查看或重开修订。
 */
/** 建议术语确认为锁定（修订号从 1 起） */
export function lockTerm(id: string) {
  const before = get(terms).find((item) => item.id === id);
  if (!before || before.status === "已锁定") return;
  const updated: GlossaryTerm = { ...before, status: "已锁定", owner: "术语管理员", revision: (before.revision || 0) + 1, lockedAt: new Date().toISOString() };
  terms.update((items) => items.map((item) => item.id === id ? updated : item));
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  logEvent(cue, "术语锁定", `${updated.source} → ${updated.target}（rev.${updated.revision}）`, "术语管理员");
  invalidateBySource(updated.source, updated.source, updated.target);
}

/** 术语锁定变化后，按术语原文联动失效相关字幕（待审即失效，已通过仅标记过期） */
function invalidateBySource(hitSource: string, nextSource: string, nextTarget: string) {
  const affectedTracks = new Set<string>();
  cues.update((items) => items.map((cue) => {
    if (!cue.source.includes(hitSource)) return cue;
    affectedTracks.add(cue.trackId);
    const note = `术语「${nextSource}」锁定已更新为「${nextTarget}」，译文需按新术语重审。`;
    if (cue.status === "已通过") {
      return { ...cue, termStale: true, reviewerNote: cue.reviewerNote || note };
    }
    // 待审（及翻译中）字幕立即失效，失效前提交版本留档
    const entry = archive(cue, "失效前版本", note, cueVariant(cue, "失效前版本", "local", cue.syncBase?.revision ?? 0));
    logEvent(cue, "术语失效", note);
    return { ...cue, status: "失效重审", termStale: true, reviewerNote: note, history: [entry, ...(cue.history ?? [])] };
  }));
  recomputePublish([], affectedTracks);
}

export function changeLockedTerm(id: string, patch: Partial<Pick<GlossaryTerm, "source" | "target">> = {}) {
  const before = get(terms).find((item) => item.id === id);
  if (!before) return;
  const revision = (before.revision || 0) + 1;
  const updated: GlossaryTerm = {
    ...before,
    ...patch,
    source: patch.source ?? before.source,
    target: patch.target ?? before.target,
    status: "已锁定",
    owner: get(reviewer),
    revision,
    lockedAt: new Date().toISOString()
  };
  terms.update((items) => items.map((item) => item.id === id ? updated : item));
  logEvent(undefined, "术语锁定", `术语锁定更新：${updated.source} → ${updated.target}（rev.${revision}）`, "术语管理员");
  invalidateBySource(before.source, updated.source, updated.target);
}

/** 离线包中到达的高版本锁定术语：直接采用远端版本号并触发同样的失效联动 */
export function applyRemoteTermLock(term: GlossaryTerm) {
  const before = get(terms).find((item) => item.id === term.id);
  terms.update((items) => items.some((item) => item.id === term.id) ? items.map((item) => item.id === term.id ? term : item) : [...items, term]);
  logEvent(undefined, "术语锁定", `离线包带入术语锁定：${term.source} → ${term.target}（rev.${term.revision}）`, "离线包");
  invalidateBySource(before?.source ?? term.source, term.source, term.target);
}

const UNFINISHED: CueStatus[] = ["待译", "翻译中", "待审", "退回", "失效重审"];

/** 计算轨道发布阻塞项：合并未完成、双版本未定稿、字幕未走完审校 */
export function computeBlockers(trackId: string, busyTrackIds: Iterable<string> = []): string[] {
  const busy = new Set(busyTrackIds);
  const blockers: string[] = [];
  if (busy.has(trackId)) blockers.push("该轨道有未完成的离线合并（失败待重试或仍在进行）");
  for (const cue of get(cues).filter((item) => item.trackId === trackId)) {
    if (cue.variants?.length) blockers.push(`${cue.id} 本机与远端两版并存，尚未定稿`);
    if (UNFINISHED.includes(cue.status)) blockers.push(`${cue.id} 状态为「${cue.status}」，未通过审校`);
  }
  return blockers;
}

/** 条件不满足的轨道一律保持未发布；已发布轨道若重新出现阻塞项则自动下架 */
export function recomputePublish(busyTrackIds: string[] = [], forceTracks?: Set<string>) {
  const busy = new Set(busyTrackIds);
  tracks.update((all) => all.map((track) => {
    if (!track.published && !(forceTracks?.has(track.id))) return track;
    const blockers = computeBlockers(track.id, busy);
    if (blockers.length && track.published) {
      logEvent(undefined, "发布", `轨道「${track.name}」出现未处理内容，自动下架暂不发布`, "系统");
      return { ...track, published: false };
    }
    return track;
  }));
}

/** 未处理完的轨道暂不发布；返回阻塞项供界面提示 */
export function publishTrack(trackId: string, busyTrackIds: string[] = []): string[] {
  const blockers = computeBlockers(trackId, busyTrackIds);
  if (blockers.length) return blockers;
  tracks.update((all) => all.map((track) => track.id === trackId ? { ...track, published: true, status: "已通过" } : track));
  const track = get(tracks).find((item) => item.id === trackId);
  logEvent(undefined, "发布", `轨道「${track?.name}」已通过全部检查并发布`, "系统");
  return [];
}

export function unpublishTrack(trackId: string, reason: string) {
  const track = get(tracks).find((item) => item.id === trackId);
  tracks.update((all) => all.map((item) => item.id === trackId ? { ...item, published: false } : item));
  logEvent(undefined, "发布", `轨道「${track?.name}」下架：${reason}`, "系统");
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

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));
