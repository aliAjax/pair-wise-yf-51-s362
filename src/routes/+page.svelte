<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { activeCues, activeTrackId, conflicts, computeBlockers, createSnapshot, cues, changeLockedTerm, applyRemoteTermLock, lockTerm, mergeNext, nudgeCue, publishTrack, recomputePublish, reopenCue, resolveConflict, restoreSnapshot, reviewCue, reviewEvents, selectedCueId, setCueStatus, snapshots, splitCue, terms, tracks, unpublishTrack, updateCue } from "$lib/stores/subtitles";
  import type { Cue, CueHistoryEntry } from "$lib/stores/subtitles";
  import { busyTrackIds, clearCheckpoint, getCheckpoint, mergeOfflinePackage, previewRemoteTerms, resolveVariant, retryMerge, sampleRemotePackages } from "$lib/stores/offlineSync";
  import type { MergeCheckpoint, OfflinePackage } from "$lib/stores/offlineSync";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = { id: crypto.randomUUID(), trackId: $activeTrackId, start, end: start + Number(formData.get("duration") ?? 2.5), source: String(formData.get("source") ?? ""), translated: String(formData.get("translated") ?? ""), status: "翻译中", translator: "当前译者", reviewerNote: "", variants: [], history: [] };
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  let reviewNote = $state("");

  // —— 离线包对接 ——
  const packages = sampleRemotePackages();
  let checkpoint = $state<MergeCheckpoint | null>(null);
  let merging = $state(false);
  let lastMergeError = $state("");

  function refreshCheckpoint() {
    checkpoint = getCheckpoint();
  }
  onMount(refreshCheckpoint);

  async function runMerge(pack: OfflinePackage, retry = false) {
    merging = true;
    lastMergeError = "";
    try {
      const ck = retry ? await retryMerge(pack) : await mergeOfflinePackage(pack);
      // 包里的高版本锁定术语在合并成功后入库，立即触发待审字幕失效重审
      for (const { term } of previewRemoteTerms(pack)) applyRemoteTermLock(term);
      checkpoint = ck;
    } catch (err) {
      lastMergeError = err instanceof Error ? err.message : String(err);
    } finally {
      merging = false;
      refreshCheckpoint();
      recomputePublish(get(busyTrackIds));
    }
  }

  function packProgress(pack: OfflinePackage) {
    const ck = checkpoint?.packageId === pack.packageId ? checkpoint : null;
    return ck ? { done: ck.processed.length, total: ck.items.length, phase: ck.phase, error: ck.lastError } : null;
  }

  function checkpointDetail(ck: MergeCheckpoint) {
    const done = ck.items.filter((i) => i.status === "已补入" || i.status === "已保留双版").length;
    const skipped = ck.items.filter((i) => i.status === "已跳过").length;
    const failed = ck.items.filter((i) => i.status === "失败").length;
    return `开始于 ${new Date(ck.startedAt).toLocaleTimeString("zh-CN")} · 补入 ${done} · 跳过 ${skipped} · 失败 ${failed}；重试时从断点继续，已处理条目不重复。`;
  }

  function dismissCheckpoint() {
    clearCheckpoint();
    refreshCheckpoint();
    recomputePublish(get(busyTrackIds));
  }

  const blockers = $derived(computeBlockers($activeTrackId, $busyTrackIds));

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  let historyCueId = $state<string | null>(null);
  const historyCue = $derived($cues.find((cue) => cue.id === historyCueId));

  // 模拟术语锁定变化：术语管理员修改一条锁定术语的译文
  function bumpTerm(id: string) {
    const term = $terms.find((item) => item.id === id);
    if (!term) return;
    const nextTarget = prompt(`术语「${term.source}」锁定译文变更为：`, term.target);
    if (nextTarget && nextTarget !== term.target) changeLockedTerm(id, { target: nextTarget });
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>多语种轨道、术语锁定与审校反馈在同一时间轴协作。</p></div><div class="header-actions"><select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics">
      <article><span>当前轨道</span><b>{activeTrack?.name}</b>{#if activeTrack?.published}<small class="ok">● 已发布</small>{:else}<small class="warn">○ 未发布</small>{/if}</article>
      <article><span>字幕条数</span><b>{$activeCues.length}</b></article>
      <article><span>待审 / 失效重审</span><b>{$activeCues.filter((cue) => cue.status === "待审" || cue.status === "失效重审").length}</b></article>
      <article><span>双版本待定稿</span><b>{$activeCues.filter((cue) => cue.variants?.length).length}</b></article>
    </section>

    <section class="panel offline">
      <div class="panel-head"><div><h2>离线轨道包对接</h2><small>不同城市断网译制后带回的包，按轨道与字幕标识对接；失败可从断点重试</small></div>{#if checkpoint}<span class="chip {checkpoint.phase === '已完成' ? '已通过' : checkpoint.phase === '失败' ? '退回' : '待审'}">{checkpoint.packageId} · {checkpoint.phase}</span>{/if}</div>
      <div class="pack-grid">
        {#each packages as pack}
          {@const pp = packProgress(pack)}
          <article class="pack">
            <header><b>{pack.city}</b><span class="chip">{pack.packageId}</span></header>
            <p>{pack.author} 导出 · {pack.cues.length} 条字幕{pack.terms?.length ? ` · ${pack.terms.length} 条术语锁定` : ""}</p>
            <ul class="pack-cues">{#each pack.cues as rc}<li><span class="mono">{rc.trackId}/{rc.id}</span><em>{rc.translated.slice(0, 22)}…</em></li>{/each}</ul>
            {#if pp}
              <div class="progress"><i class={pp.phase === "失败" ? "fail" : ""} style={`width:${Math.round((pp.done / pp.total) * 100)}%`}></i></div>
              <small class={pp.phase === "失败" ? "warn" : "ok"}>{pp.done}/{pp.total} 已落库{pp.phase === "失败" ? ` · ${pp.error ?? "解包失败"}` : pp.phase === "已完成" ? " · 对接完成" : ""}</small>
              {#if pp.phase === "失败"}<button class="btn btn-sm variant-filled-error" disabled={merging} onclick={() => runMerge(pack, true)}>从断点重试（{pp.done}/{pp.total}）</button>{/if}
            {:else}
              <button class="btn btn-sm variant-filled-primary" disabled={merging} onclick={() => runMerge(pack)}>对接离线包{pack.failBeforeTrack ? "（首次模拟失败）" : ""}</button>
            {/if}
          </article>
        {/each}
      </div>
      {#if checkpoint}
        <div class="ck">
          <b>断点记录</b>
          <div class="ck-items">{#each checkpoint.items as item}<span class="chip {item.status === '失败' ? '退回' : item.status === '已保留双版' || item.status === '已补入' ? '已通过' : item.status === '已跳过' ? '' : '待审'}">{item.trackId}/{item.cueId} · {item.status}</span>{/each}</div>
          <small>{checkpointDetail(checkpoint)}</small>
          <button class="btn btn-sm" onclick={dismissCheckpoint}>清除断点记录</button>
        </div>
      {/if}
      {#if lastMergeError}<p class="warn">最近一次合并失败：{lastMergeError} —— 已处理条目保留在断点中，可直接重试。</p>{/if}
    </section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>本机已拆并片段保留现有时序；远端新译按字幕标识补入</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>{#if cue.variants?.length}<small class="warn">⚠ 本机/远端两版并存，待定稿</small>{/if}{#if cue.termStale && cue.status === "已通过"}<small class="warn">⚠ 术语锁定已变化，通过版本过期</small>{/if}</div>
                <span class="cue-badges">{#if cue.history?.length}<button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); historyCueId = cue.id; }}>历史 {cue.history.length}</button>{/if}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel publish-panel">
          <div class="panel-head"><h2>轨道发布</h2>{#if activeTrack?.published}<span class="chip 已通过">已发布</span>{:else}<span class="chip 退回">未发布</span>{/if}</div>
          {#if blockers.length}
            <ul class="blockers">{#each blockers as blocker}<li>{blocker}</li>{/each}</ul>
            <small class="warn">存在未处理内容，该轨道暂不发布。</small>
          {:else}
            <p class="ok">所有字幕已定稿并通过审校，可以发布。</p>
          {/if}
          <div class="actions">
            <button class="btn variant-filled-success" disabled={!!blockers.length || activeTrack?.published} onclick={() => publishTrack($activeTrackId, $busyTrackIds)}>发布轨道</button>
            {#if activeTrack?.published}<button class="btn btn-sm" onclick={() => unpublishTrack($activeTrackId, "手动下架")}>下架</button>{/if}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status}</span>{/if}</div>
          {#if selected}
            {#if selected.variants?.length}
              <div class="variants">
                <b class="warn">两边都改过：两版并存，定稿前阻塞发布</b>
                {#each selected.variants as v, vi}
                  <article class={`variant ${v.origin}`}>
                    <header><span class="chip">{v.label}</span><small>{formatTime(v.start)}–{formatTime(v.end)} · {v.translator} · rev.{v.revision}</small></header>
                    <p>{v.translated}</p>
                    <button class="btn btn-sm variant-filled-primary" onclick={() => resolveVariant(selected.id, v.origin)}>采用{v.label}{vi === 0 ? "（保留现有时序）" : ""}</button>
                  </article>
                {/each}
              </div>
            {/if}
            {#if selected.termStale && selected.status === "已通过"}
              <div class="stale-banner"><b>术语锁定已变化</b><p>{selected.reviewerNote}</p><div class="actions"><button class="btn btn-sm variant-filled-error" onclick={() => reopenCue(selected.id, "按新术语重开修订，已通过版本已留档")}>重开修订</button><button class="btn btn-sm" onclick={() => (historyCueId = selected.id)}>查看已通过版本</button></div></div>
            {/if}
            {#if selected.status === "失效重审"}
              <div class="stale-banner"><b>该字幕已因术语锁定变化立即失效</b><p>{selected.reviewerNote}</p><small>失效前版本已留档，可在历史中查看；修订后重新提交审校。</small></div>
            {/if}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定变化时，待审字幕立即失效重进审校</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {term.target} <small>rev.{term.revision}</small></span><span class="term-actions"><button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button><button class="btn btn-sm" title="模拟术语管理员修改锁定译文" onclick={() => bumpTerm(term.id)}>锁定变更</button></span></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突（时序）</h2></div>
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机时序</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2></div><div class="events">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>
  </main>
</div>

{#if historyCue}
  <div class="modal-backdrop" onclick={() => (historyCueId = null)} onkeydown={(event) => { if (event.key === "Escape") historyCueId = null; }} role="presentation">
    <div class="modal" tabindex="-1" onclick={(event) => event.stopPropagation()} onkeydown={(event) => event.stopPropagation()} role="dialog" aria-label="字幕历史版本">
      <div class="panel-head"><div><h2>历史版本 · {historyCue.id}</h2><small>已通过版本、失效前版本、双版本定稿留档均可查看</small></div><button class="btn btn-sm" onclick={() => (historyCueId = null)}>关闭</button></div>
      <div class="events">
        {#each (historyCue.history ?? []) as entry}
          {@const h = entry as CueHistoryEntry}
          <article><b>{h.label}</b><p>{h.variant.translated}</p><small>{h.reason}</small><small>{formatTime(h.variant.start)}–{formatTime(h.variant.end)} · {h.variant.translator} · {new Date(h.savedAt).toLocaleString("zh-CN")}</small></article>
        {:else}<p>暂无历史版本。</p>{/each}
      </div>
    </div>
  </div>
{/if}
