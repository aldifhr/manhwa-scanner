<script lang="ts">
  import { onMount } from "svelte";
  import { rewriteCoverUrl } from "$lib/utils";
  let { data }: any = $props();
  // handle all backend shapes: {data:[...]}, {data:{results:[...]}}, {data:{data:[...]}}, {results:[...]}, {whitelists:[...]}
  let raw: any = $derived(data?.raw ?? data?.data);
  let items: any = $derived(raw?.data ?? raw ?? data?.data);
  let arr: any[] = $derived(
    Array.isArray(items) ? items
    : Array.isArray(items?.results) ? items.results
    : Array.isArray(items?.data) ? items.data
    : Array.isArray(items?.whitelists) ? items.whitelists
    : Array.isArray(raw?.results) ? raw.results
    : []
  );
  let isUnauthorized = $derived(data?.status === 401 || String(data?.error||"").toLowerCase().includes("unauthorized"));
  let q = $state("");
  let srcFilter: string | null = $state(null);
  let sources: string[] = $derived([...new Set(arr.map(a=> a.source ?? (Array.isArray(a.sources)? (typeof a.sources[0]==="string"?a.sources[0]:(a.sources[0] as any)?.source): "")).filter(Boolean))].sort());
  let filtered: any[] = $derived(arr.filter(it=>{
    const t = (it.title ?? it.titleKey ?? it.title_key ?? "").toLowerCase();
    if (q && !t.includes(q.toLowerCase())) return false;
    const s = it.source ?? (Array.isArray(it.sources)? (typeof it.sources[0]==="string"?it.sources[0]:(it.sources[0] as any)?.source): "");
    if (srcFilter && s!==srcFilter) return false;
    return true;
  }));
  function btnActive(a:boolean){ return a? "bg-white text-black" : "bg-white/[0.06] text-white/70 hover:bg-white/10"; }
  // Search-to-add state
  let addQ = $state("");
  let addResults: any[] = $state([]);
  let addLoading = $state(false);
  let addOptimistic = $state<Set<string>>(new Set());
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onAddQ(v: string) {
    addQ = v;
    if (searchTimer) clearTimeout(searchTimer);
    if (!v.trim()) { addResults = []; return; }
    searchTimer = setTimeout(async () => {
      addLoading = true;
      try {
        const res = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(v)}`);
        if (res.ok) {
          const j = await res.json();
          addResults = j?.data?.results ?? [];
        }
      } catch {}
      addLoading = false;
    }, 300);
  }
  async function addWL(item: any) {
    try {
      const res = await fetch("/api/v1/reader/whitelist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title_key: item.titleKey,
          title: item.title,
          source: item.source,
          cover: item.cover,
          series_url: item.url,
          origin: item.origin,
        }),
      });
      if (res.ok) {
        addOptimistic = new Set([...addOptimistic, item.titleKey]);
      }
    } catch {}
  }
</script>
<div class="max-w-5xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Whitelist</h1>
  {#if data.error && !isUnauthorized}<div class="mt-3 p-3 bg-red-500/10 text-red-400 text-sm">{data.error}</div>{/if}
  {#if isUnauthorized}
    <div class="mt-4 p-4 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">Login required — <a href="/login?redirect=/whitelist" class="underline">login</a> to see whitelist</div>
  {:else}
    <div class="mt-3 flex flex-col gap-2">
      <input type="text" placeholder="Search title..." bind:value={q} class="w-full sm:w-64 bg-[#18181b] border border-white/[0.08] rounded-full px-3 py-1.5 text-sm placeholder:text-white/30 focus:outline-none focus:border-white/20" />
      <div class="flex flex-wrap gap-2">
        <button onclick={()=>srcFilter=null} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(srcFilter===null)}>All Sources</button>
        {#each sources as s}<button onclick={()=>srcFilter=srcFilter===s?null:s} class={"min-h-0 px-3 py-1 text-xs rounded-full capitalize "+btnActive(srcFilter===s)}>{s}</button>{/each}
      </div>
    </div>
    <p class="text-white/60 text-sm mt-3">{filtered.length} / {arr.length} titles</p>
    <div class="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {#each filtered.slice(0,100) as it}
        {@const rating = it.rating ?? it.score}
        {@const origin = it.origin ?? it.country}
        {@const genres = it.genres ?? it.tags ?? []}
        {@const desc = it.description}
        {@const src = it.source ?? (Array.isArray(it.sources) ? (typeof it.sources[0]==="string"? it.sources[0] : (it.sources[0] as any)?.source) : "")}
        <a href={it.series_url ?? it.seriesUrl ?? it.url ?? "#"} target="_blank" rel="noopener noreferrer" class="group relative overflow-hidden rounded-xl border border-white/10 bg-black aspect-[3/4] block">
          {#if it.cover || it.cover_url}<img src={rewriteCoverUrl((it.cover ?? it.cover_url) as string)||""} alt={it.title ?? it.title_key} class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />{/if}
          <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent opacity-90"></div>
          <div class="absolute bottom-0 inset-x-0 p-3 flex flex-col gap-1">
            <div class="font-medium text-sm leading-tight line-clamp-2 text-white drop-shadow">{it.title ?? it.titleKey ?? it.title_key ?? it.canonical_title_key}</div>
            <div class="flex flex-wrap gap-1">
              {#if src}<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-white/15 backdrop-blur capitalize text-white">{src}</span>{/if}
              {#if origin}<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-white/15 backdrop-blur uppercase text-white">{String(origin).slice(0,3)}</span>{/if}
              {#if it.type}<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-white/15 backdrop-blur capitalize text-white">{it.type}</span>{/if}
              {#if rating && Number(rating)>0}<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-amber-500/90 text-white">★ {Number(rating).toFixed(1)}</span>{/if}
            </div>
            {#if Array.isArray(genres) && genres.length}<div class="text-[10px] text-white/70 line-clamp-1">{genres.slice(0,3).join(" · ")}</div>{/if}
          </div>
        </a>
      {/each}
      {#if filtered.length===0}
        <div class="text-white/40 text-sm mt-6">Empty — no whitelist yet. Add from Home via + Add WL</div>
      {/if}
    </div>
    <!-- Add new WL section -->
    <div class="mt-6 p-4 rounded-xl border border-white/10 bg-white/5">
      <h2 class="text-sm font-semibold">Add to Whitelist</h2>
      <p class="text-xs text-white/40 mt-1">Search by title, select source, then add.</p>
      <div class="mt-3 flex gap-2">
        <input type="text" placeholder="Search title..." value={addQ} oninput={(e)=>onAddQ((e.target as HTMLInputElement).value)} class="flex-1 bg-[#18181b] border border-white/[0.08] rounded-full px-3 py-1.5 text-sm placeholder:text-white/30 focus:outline-none focus:border-white/20" />
        {#if addLoading}<span class="text-xs text-white/40 self-center">...</span>{/if}
      </div>
      {#if addResults.length > 0}
        <div class="mt-3 space-y-2 max-h-64 overflow-y-auto">
          {#each addResults as r}
            <div class="flex items-center justify-between p-2 rounded-lg bg-black/30 border border-white/5">
              <div class="flex-1 min-w-0">
                <div class="text-sm truncate">{r.title}</div>
                <div class="text-[10px] text-white/40 capitalize">{r.source} · {r.origin}</div>
              </div>
              {#if r.isInWhitelist || addOptimistic.has(r.titleKey)}
                <span class="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-400">Added</span>
              {:else}
                <button onclick={()=>addWL(r)} class="min-h-0 text-[10px] px-2 py-1 rounded bg-white text-black">+ Add</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
