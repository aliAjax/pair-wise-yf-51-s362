import { createServer } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
  clear: () => storeMap.clear()
};
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "u" + Math.random().toString(36).slice(2, 10) }, configurable: true });
}

const vite = await createServer({
  server: { middlewareMode: true },
  logLevel: "error",
  configFile: false,
  resolve: { alias: { "$app/environment": new URL("./stubs/app-environment.js", import.meta.url).pathname } },
  plugins: [sveltekit()]
});

const subs = await vite.ssrLoadModule("/src/lib/stores/subtitles.ts");
const sync = await vite.ssrLoadModule("/src/lib/stores/offlineSync.ts");
const { get } = await import("svelte/store");

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => console.log("PASS", name)).catch((err) => { failures++; console.error("FAIL", name, err); });
    }
    console.log("PASS", name);
  } catch (err) { failures++; console.error("FAIL", name, err); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function reset() { localStorage.clear(); }

const basePack = () => ({
  packageId: "PKG-TEST", author: "R", city: "X", exportedAt: new Date().toISOString(), baseRevision: 3,
  cues: [
    { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "REMOTE-c2", status: "待审", translator: "R", baseRevision: 3 },
    { id: "c3", trackId: "en", start: 3.2, end: 6.4, source: "修复组必须在下一场潮水到来前完成加固。", translated: "REMOTE-c3", status: "待审", translator: "R", baseRevision: 3 }
  ]
});

await check("远端新译补入且本机时序保留", async () => {
  reset();
  const before = get(subs.cues).find((c) => c.id === "c2");
  await sync.mergeOfflinePackage(basePack());
  const c2 = get(subs.cues).find((c) => c.id === "c2");
  assert(c2.translated === "REMOTE-c2", "远端新译应补入");
  assert(c2.start === before.start && c2.end === before.end, "本机时序必须保留");
});

await check("两边都改保留两版并阻塞发布", async () => {
  reset();
  subs.nudgeCue("c3", 0.4); // 本机改时序，构成双方修改
  await sync.mergeOfflinePackage(basePack());
  const c3 = get(subs.cues).find((c) => c.id === "c3");
  assert(c3.variants?.length === 2, "应有两版并存");
  assert(subs.computeBlockers("en", []).some((b) => b.includes("两版并存")), "双版本应阻塞发布");
  assert(subs.publishTrack("en", []).length > 0, "存在未定稿版本时不允许发布");
});

await check("合并失败保留断点，重试从断点续并", async () => {
  reset();
  const p = {
    packageId: "PKG-FAIL", author: "R", city: "X", exportedAt: "", baseRevision: 3, failBeforeTrack: "ja",
    cues: [
      { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "A", status: "待审", translator: "R", baseRevision: 3 },
      { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "JA-A", status: "待译", translator: "R", baseRevision: 3 }
    ]
  };
  let threw = false;
  try { await sync.mergeOfflinePackage(p); } catch { threw = true; }
  assert(threw, "首次合并应在 ja 轨失败");
  const ck = sync.getCheckpoint();
  assert(ck.phase === "失败" && ck.processed.includes("en:c2"), "断点应记录已处理条目");
  assert(get(sync.busyTrackIds).includes("ja"), "失败轨道应处于忙碌状态");
  assert(get(subs.cues).find((c) => c.id === "c2").translated === "A", "断点前结果保留");
  const ck2 = await sync.retryMerge(p);
  assert(ck2.phase === "已完成" && ck2.processed.length === 2, "重试应从断点完成全部条目");
  assert(get(subs.cues).find((c) => c.id === "c4").translated === "JA-A", "续并后 ja 轨新译落库");
});

await check("双版本定稿后未采用版留档并重进待审", async () => {
  reset();
  subs.nudgeCue("c3", 0.4);
  await sync.mergeOfflinePackage(basePack());
  sync.resolveVariant("c3", "remote");
  const c3 = get(subs.cues).find((c) => c.id === "c3");
  assert((c3.variants?.length ?? 0) === 0, "定稿后双版本应收口");
  assert(c3.translated === "REMOTE-c3" && c3.status === "待审", "应采用远端译文并重进待审");
  assert(c3.history.some((h) => h.label === "本机版"), "未采用的本机版应留档可查看");
});

await check("术语锁定升级：待审立即失效重审，已通过仅过期可查看", async () => {
  reset();
  subs.applyRemoteTermLock({ id: "g2", source: "码头", target: "dock", status: "已锁定", owner: "术语管理员", revision: 9, lockedAt: new Date().toISOString() });
  const c2 = get(subs.cues).find((c) => c.id === "c2");
  assert(c2.status === "失效重审", "待审字幕应立即失效重进审校");
  assert(c2.history.some((h) => h.label === "失效前版本"), "失效前版本应留档");
  const c1 = get(subs.cues).find((c) => c.id === "c1");
  assert(c1.status === "已通过" && c1.termStale === true, "已通过版本不撤审但标记过期");
});

await check("已发布轨道出现未完成合并时自动下架", async () => {
  reset();
  assert(get(subs.tracks).find((t) => t.id === "zh").published === true, "种子 zh 轨初始已发布");
  const p = { packageId: "PKG-ZH", author: "r", city: "Y", exportedAt: "", baseRevision: 3, failBeforeTrack: "zh", cues: [{ id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "X", status: "待审", translator: "r", baseRevision: 3 }] };
  let threw = false;
  try { await sync.mergeOfflinePackage(p); } catch { threw = true; }
  assert(threw, "zh 轨解包应失败");
  assert(get(subs.tracks).find((t) => t.id === "zh").published === false, "未处理完的轨道应自动下架暂不发布");
});

await vite.close();
if (failures) { console.error(`\n${failures} 个断言失败`); process.exit(1); }
console.log("\n全部冒烟用例通过");
