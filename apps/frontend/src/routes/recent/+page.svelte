<script lang="ts">
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  import { toast } from "$lib/toast.svelte";
  let { data }: any = $props();
  let results: any[] = $derived(data?.feed?.data?.results ?? []);
  let groupedAll = $derived(results.length ? groupChapters(results as any) : []);
  let sourceFilter: string | null = $state(null);
  let countryFilter: string | null = $state(null);
  let wlFilter: "all"|"wl"|"non" = $state("all");
  let sources: string[] = $derived([...new Set(groupedAll.flatMap(s=>s.chapters.map(c=>c.source)))].sort());
  let filtered = $derived(groupedAll.filter(s=>{
    if (sourceFilter && !s.chapters.some(c=>c.source===sourceFilter)) return false;
    if (countryFilter) {
      const o=(s.origin||"").toLowerCase();
      if (countryFilter==="korean" && o!=="kr" && o!=="korean") return false;
      if (countryFilter==="chinese" && o!=="cn" && o!=="chinese") return false;
    }
    if (wlFilter==="wl" && !s.isWhitelisted) return false;
    if (wlFilter==="non" && s.isWhitelisted) return false;
    return true;
  }));
  let visible = $state(30);
  let grouped = $derived(filtered.slice(0, visible));
  // reset visible when filters change
  $effect(()=>{ void filtered.length; visible=30; });
  let adding: string | null = $state(null);
  let optimistic = $state<Set<string>>(new Set());
  async function addWL(s: any) {
    adding = s.titleKey;
    try {
      const res = await fetch("/api/v1/reader/whitelist", withCsrf({ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key: s.titleKey, title: s.title, source: s.chapters[0]?.source, cover: s.cover, series_url: s.seriesUrl, origin: s.origin, genres: s.genres, description: s.description }) }));
      if (!res.ok) throw new Error(await res.text());
      optimistic = new Set([...optimistic, s.titleKey]);
      toast("Added to whitelist", "success");
    } catch(e:any){ toast(e?.message?.slice(0,300) || "Add WL failed", "error"); } finally { adding=null; }
  }
  function btnActive(active: boolean){ return active ? "bg-[var(--gold-accent)] text-black" : "bg-white/10 text-white/70 hover:bg-white/20"; }
  let sentinel: HTMLDivElement | null = $state(null);
  $effect(()=>{
    if (!sentinel) return;
    const io = new IntersectionObserver((entries)=>{
      if (entries[0]?.isIntersecting && visible < filtered.length) visible = Math.min(visible+30, filtered.length);
    }, { rootMargin: "400px" });
    io.observe(sentinel);
    return ()=>io.disconnect();
  });
</script>
<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Recent</h1>
  <p class="text-white/60 text-sm mt-1">Latest grouped feed — {grouped.length} / {groupedAll.length} series</p>
  <!-- filters -->
  <div class="mt-3 flex flex-col gap-2">
    <div class="flex flex-wrap gap-2">
      <button onclick={()=>wlFilter="all"} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(wlFilter==="all")}>All</button>
      <button onclick={()=>wlFilter="non"} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(wlFilter==="non")}>Non-WL</button>
      <button onclick={()=>wlFilter="wl"} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(wlFilter==="wl")}>WL</button>
    </div>
    <div class="flex flex-wrap gap-2">
      <button onclick={()=>countryFilter=null} class={"min-h-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full "+btnActive(countryFilter===null)}>All Countries</button>
      <button onclick={()=>countryFilter=countryFilter==="korean"?null:"korean"} class={"min-h-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full "+btnActive(countryFilter==="korean")}>Korea</button>
      <button onclick={()=>countryFilter=countryFilter==="chinese"?null:"chinese"} class={"min-h-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full "+btnActive(countryFilter==="chinese")}>China</button>
      <span class="w-px h-4 bg-white/10 self-center mx-1"></span>
      <button onclick={()=>sourceFilter=null} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(sourceFilter===null)}>All Sources</button>
      {#each sources as s}
        <button onclick={()=>sourceFilter=sourceFilter===s?null:s} class={"min-h-0 px-3 py-1 text-xs rounded-full capitalize "+btnActive(sourceFilter===s)}>{s}</button>
      {/each}
    </div>
  </div>
  {#if data.error}
    <div class="mt-4 p-3 rounded bg-red-500/10 text-red-400 text-sm">{data.error}</div>
  {:else if filtered.length === 0}
    <div class="mt-8 text-center text-white/40">No data</div>
  {:else}
    <div class="mt-4 flex flex-col gap-3">
      {#each grouped as s (s.titleKey)}
        <div class="flex gap-3 p-3 rounded-xl border border-white/10 bg-white/5">
          {#if s.cover}<img src={rewriteCoverUrl(s.cover)||""} alt={s.title} class="w-16 h-24 object-cover rounded" />{/if}
          <div class="flex-1 min-w-0">
            <a href={s.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="font-semibold text-sm truncate hover:text-white/80">{decodeHtml(s.title)}</a>
            <div class="flex gap-1 flex-wrap mt-1">{#each s.chapters.slice(0,5) as c}<a href={c.chapterUrl || c.url || "#"} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center text-[11px] px-2 py-1 bg-white/10 hover:bg-white/20 rounded leading-none" style="line-height:1">Ch. {getChapterLabel(c as any)} · {c.source}</a>{/each}</div>
            {#if s.description}<p class="text-[11px] text-white/55 line-clamp-2 mt-1">{decodeHtml(s.description)}</p>{/if}
            {#if s.isWhitelisted}
              <span class="min-h-0 mt-2 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">✓ Added</span>
            {:else}
              {#if s.isWhitelisted || optimistic.has(s.titleKey)}
              <span class="min-h-0 mt-2 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">✓ Added</span>
            {:else}
              <button onclick={() => addWL(s)} disabled={adding===s.titleKey} class="min-h-0 mt-2 text-[11px] px-2.5 py-1 rounded-full bg-[var(--gold-accent)] text-black disabled:opacity-50">{adding===s.titleKey?"...":"+ Add WL"}</button>
            {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <div bind:this={sentinel} class="h-8"></div>
    {#if visible < filtered.length}<div class="text-center text-xs text-white/30 py-2">Loading more... ({visible}/{filtered.length})</div>{/if}
  {/if}
</div>
