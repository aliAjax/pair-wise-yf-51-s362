<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { activeCues, activeTrackId, conflicts, createSnapshot, cueConflicts, cueVersions, cues, lockTerm, makeMockOfflinePackage, mergeNext, mergeOfflinePackage, nudgeCue, offlinePackages, publishTrack, resolveConflict, resolveCueConflict, restoreCueVersion, restoreSnapshot, reviewCue, reviewEvents, reviewer, selectedCueId, setCueStatus, snapshots, splitCue, terms, tracks, updateCue, updateTermTarget } from "$lib/stores/subtitles";
  import type { Cue } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = { id: crypto.randomUUID(), trackId: $activeTrackId, start, end: start + Number(formData.get("duration") ?? 2.5), source: String(formData.get("source") ?? ""), translated: String(formData.get("translated") ?? ""), status: "翻译中", translator: "当前译者", reviewerNote: "" };
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  let reviewNote = $state("");
  let publishError = $state("");

  function publishActiveTrack() {
    const result = publishTrack($activeTrackId);
    if (result.ok) {
      publishError = "";
      return;
    }
    const names = result.unfinished.map((cue) => cue.source.slice(0, 8)).join("、");
    publishError = `轨道「${activeTrack?.name}」未处理完，暂不发布：${result.unfinished.length} 条字幕未通过审校` +
      (result.openConflicts.length ? `，${result.openConflicts.length} 个译文冲突待解决` : "") +
      `（${names}）`;
  }

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
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

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>拖动或点击选择，所有修改保存到浏览器本地</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p></div>
                <span class={`chip ${cue.status}`}>{cue.status}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status}</span>{/if}</div>
          {#if selected}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
            <div class="versions">
              <b>历史通过版本</b>
              {#each $cueVersions.filter((version) => version.cueId === selected.id) as version}
                <div class="version"><small>第 {version.version} 版 · {new Date(version.approvedAt).toLocaleString("zh-CN")}</small><p>{version.translated}</p><button class="btn btn-sm" onclick={() => restoreCueVersion(version.cueId, version.id)}>恢复此版译文</button></div>
              {:else}<small>暂无通过版本；术语锁定导致待审失效后，已通过版本仍可在此查看。</small>{/each}
            </div>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定术语不会被普通翻译直接覆盖</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {#if term.status === "已锁定"}<input class="input term-target" value={term.target} aria-label="术语目标译文" onchange={(event) => updateTermTarget(term.id, event.currentTarget.value)} />{:else}{term.target}{/if}</span><button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2></div>
          {#each $cueConflicts as conflict}
            <article class="conflict">
              <b>译文冲突 · 已保留两版</b>
              <p class="version-line">本地版：{conflict.localVersion.translated || "（空）"}</p>
              <p class="version-line">远端版：{conflict.remoteVersion.translated || "（空）"}</p>
              <div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveCueConflict(conflict.id, "本地")}>保留本地</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveCueConflict(conflict.id, "远端")}>采用远端</button><span class="chip">{conflict.status}</span></div>
            </article>
          {/each}
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
          {#if !$cueConflicts.length && !$conflicts.length}<p>暂无冲突。</p>{/if}
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

    <section class="panel package-panel">
      <div class="panel-head">
        <div><h2>离线包对接</h2><small>外地组断网译制后回传；按轨道与字幕标识合并，本地拆并保留时序，失败可从断点重试</small></div>
        <div class="actions">
          <button class="btn" onclick={() => makeMockOfflinePackage($activeTrackId)}>生成模拟离线包（{activeTrack?.name}）</button>
          <button class="btn variant-filled-primary" onclick={publishActiveTrack}>发布当前轨道</button>
        </div>
      </div>
      {#if publishError}<p class="publish-error">{publishError}</p>{/if}
      <div class="package-list">
        {#each $offlinePackages as pkg}
          <article class="package">
            <div class="package-head"><b>{pkg.label}</b><span class={`chip ${pkg.status}`}>{pkg.status}</span></div>
            <small>回传时间 {new Date(pkg.exportedAt).toLocaleString("zh-CN")} · {pkg.cues.length} 条字幕 · 已合并 {pkg.mergedCueIds.length}/{pkg.cues.length}{#if pkg.conflictIds.length} · 保留两版 {pkg.conflictIds.length}{/if}</small>
            <div class="progress"><i style="width: {Math.round((pkg.mergedCueIds.length / pkg.cues.length) * 100)}%"></i></div>
            {#if pkg.error}<p class="package-error">{pkg.error}</p>{/if}
            {#if pkg.log.length}<ul class="package-log">{#each pkg.log as line}<li>{line}</li>{/each}</ul>{/if}
            <div class="actions"><button class="btn btn-sm variant-filled-primary" disabled={pkg.status === "已合并" || pkg.status === "合并中"} onclick={() => mergeOfflinePackage(pkg.id)}>{pkg.status === "失败" ? "断点重试" : "合并离线包"}</button></div>
          </article>
        {/each}
        {#if !$offlinePackages.length}<p>暂无离线包。可生成模拟包演示：两边都改保留两版、远端新译补入、时序保留本地、首次合并中断后断点重试。</p>{/if}
      </div>
    </section>
  </main>
</div>
