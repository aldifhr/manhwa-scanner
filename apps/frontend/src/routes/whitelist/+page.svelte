<script lang="ts">
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
</script>
<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Whitelist</h1>
  {#if data.error && !isUnauthorized}<div class="mt-3 p-3 bg-red-500/10 text-red-400 text-sm">{data.error}</div>{/if}
  {#if isUnauthorized}
    <div class="mt-4 p-4 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">Login required — <a href="/login?redirect=/whitelist" class="underline">login</a> to see whitelist</div>
  {:else}
    <p class="text-white/60 text-sm mt-1">{arr.length} titles</p>
    <div class="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {#each arr.slice(0,100) as it}
        {@const rating = it.rating ?? it.score}
        {@const origin = it.origin ?? it.country}
        {@const genres = it.genres ?? it.tags ?? []}
        {@const desc = it.description}
        {@const src = it.source ?? (Array.isArray(it.sources) ? (typeof it.sources[0]==="string"? it.sources[0] : (it.sources[0] as any)?.source) : "")}
        <a href={it.series_url ?? it.seriesUrl ?? it.url ?? "#"} target="_blank" rel="noopener noreferrer" class="group p-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 flex flex-col gap-2">
          {#if it.cover || it.cover_url}<img src={it.cover ?? it.cover_url} alt={it.title ?? it.title_key} class="w-full aspect-[3/4] object-cover rounded-lg bg-white/5 group-hover:scale-[1.02] transition-transform" loading="lazy" />{/if}
          <div class="text-sm flex-1 min-w-0">
            <div class="font-medium line-clamp-2 leading-tight">{it.title ?? it.titleKey ?? it.title_key ?? it.canonical_title_key}</div>
            <div class="flex flex-wrap gap-1 mt-1">
              {#if src}<span class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 capitalize">{src}</span>{/if}
              {#if origin}<span class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 uppercase">{String(origin).slice(0,3)}</span>{/if}
              {#if it.type}<span class="text-[10px] px-1.5 py-0.5 rounded bg-white/10 capitalize">{it.type}</span>{/if}
              {#if rating && Number(rating)>0}<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">★ {Number(rating).toFixed(1)}</span>{/if}
            </div>
            {#if Array.isArray(genres) && genres.length}<div class="text-[10px] text-white/40 mt-1 line-clamp-1">{genres.slice(0,3).join(" · ")}</div>{/if}
            {#if desc}<p class="text-[11px] text-white/50 line-clamp-2 mt-1">{String(desc).replace(/<[^>]+>/g," ").slice(0,120)}</p>{/if}
            <div class="text-white/30 text-[10px] mt-1 truncate">{it.titleKey ?? it.title_key}</div>
          </div>
        </a>
      {/each}
      {#if arr.length===0}
        <div class="text-white/40 text-sm mt-6">Empty — no whitelist yet. Add from Home via + Add WL</div>
        <details class="mt-3 text-xs"><summary class="text-white/30 cursor-pointer">debug raw</summary><pre class="mt-2 p-2 bg-white/5 rounded overflow-auto max-h-64">{JSON.stringify(raw, null, 2).slice(0,2000)}</pre></details>
      {/if}
    </div>
  {/if}
</div>
