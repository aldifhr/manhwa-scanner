<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { sourceChipClass, chapterSourceClass } from "$lib/styles";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  import { toast } from "$lib/toast.svelte";
  import { saveBookmark, getBookmarks } from "$lib/api";
  import type { BookmarkEntry } from "$lib/api";
  let { data }: any = $props();
  let feed = $derived(data.feed);
  let results: any[] = $derived(feed?.data?.results ?? []);
  let groupedAll = $derived(results.length ? groupChapters(results as any) : []);
  let q = $state("");
  let sortBy: "latest"|"rating"|"alpha" = $state("latest");
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let view: "grid"|"list" = $state("grid");
  let bookmarks: BookmarkEntry[] = $state([]);
  let isOnline = $state(true);
  let offlineDismissed = $state(false);
  onMount(()=>{
    const p = new URLSearchParams(location.search);
    if (p.get("q")) q = p.get("q")!;
    const s = p.get("sort");
    if (s === "rating" || s === "alpha") sortBy = s;
    if (p.get("view")==="list") view = "list";
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/reader/rss?limit=36&group=false&_=${Date.now()}`);
        if (res.ok) {
          const json = await res.json();
          if (json?.data?.results) {
            data = { feed: json, error: null };
          }
        }
      } catch {}
    }, 30_000);
    isOnline = navigator.onLine;
    const onOnline = () => { isOnline = true; offlineDismissed = false; };
    const onOffline = () => isOnline = false;
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    getBookmarks(1, 10).then(r => bookmarks = r).catch(()=>{});
    return ()=>{ window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });
  function syncUrl(){
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (sortBy !== "latest") p.set("sort", sortBy);
    if (view==="list") p.set("view", "list");
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  }
  function setQ(v: string){ q = v; syncUrl(); }
  function setSort(v: "latest"|"rating"|"alpha"){ sortBy = v; syncUrl(); }
  function setView(v: "grid"|"list"){ view = v; syncUrl(); }
  function clearFilters(){ q=""; sortBy="latest"; syncUrl(); }
  let hasActiveFilters = $derived(!!q || sortBy!=="latest");
  function sortGrouped(arr: any[]){
    if (sortBy==="rating") return [...arr].sort((a,b)=> (Number(b.rating)||0) - (Number(a.rating)||0));
    if (sortBy==="alpha") return [...arr].sort((a,b)=> (a.title||"").localeCompare(b.title||""));
    return [...arr].sort((a,b)=>{
      const da = a.chapters?.[0]?.sentAt || a.sentAt || "";
      const db = b.chapters?.[0]?.sentAt || b.sentAt || "";
      return db.localeCompare(da);
    });
  }
  let stats = $derived((()=>{
    const total = groupedAll.length;
    const ratings = groupedAll.map(s=>Number(s.rating)||0).filter(n=>n>0);
    const avg = ratings.length ? (ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(1) : "—";
    const genreCount: Record<string,number> = {};
    for(const s of groupedAll) for(const g of (s.genres||[])) genreCount[g] = (genreCount[g]||0)+1;
    const topGenres = Object.entries(genreCount).sort((a,b)=>b[1]-a[1]).slice(0,3);
    const wlCount = groupedAll.filter(s=>s.isWhitelisted).length;
    return { total, avg, topGenres, wlCount, rated: ratings.length };
  })());
  let filteredRaw = $derived((q ? groupedAll.filter(s=> (s.title||"").toLowerCase().includes(q.toLowerCase())) : groupedAll).filter(s=> !excluded.has(s.titleKey)));
  let filtered = $derived(sortGrouped(filteredRaw));
  let visible = $state(18);
  let loadingMore = $state(false);
  let shown = $derived(filtered.slice(0, visible));
  $effect(()=>{ void filtered.length; void sortBy; void q; visible=18; });
  let sentinel: HTMLDivElement | null = $state(null);
  $effect(()=>{
    if (!sentinel) return;
    const io = new IntersectionObserver((entries)=>{
      if (entries[0]?.isIntersecting && visible < filtered.length){
        loadingMore = true;
        setTimeout(()=>{ visible = Math.min(visible+18, filtered.length); loadingMore = false; }, 300);
      }
    }, { rootMargin: "400px" });
    io.observe(sentinel);
    return ()=>io.disconnect();
  });
  let adding = $state<string | null>(null);
  let optimistic = $state<Set<string>>(new Set());
  let bookmarking: string | null = $state(null);
  let bookmarked = $state<Set<string>>(new Set());
  let excluded = $state<Set<string>>(new Set());
  let excluding: string | null = $state(null);
  function sourceFromUrl(url: string): string {
    if (!url) return "";
    const h = url.toLowerCase();
    if (h.includes("ikiru")) return "ikiru";
    if (h.includes("shinigami")) return "shinigami";
    if (h.includes("voratoon")) return "voratoon";
    return "";
  }
  async function excludeTitle(titleKey: string, title: string, source: string) {
    excluding = titleKey;
    try {
      const res = await fetch("/api/v1/excluded-titles", withCsrf({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title_key: titleKey, title, source }),
      }));
      if (res.ok) {
        excluded = new Set([...excluded, titleKey]);
        toast("Excluded from feed", "success");
      } else if (res.status === 401 || res.status === 403) {
        toast("Login required to exclude", "error");
      } else {
        const t = await res.text().catch(()=>"");
        toast(t.slice(0,120) || "Exclude failed", "error");
      }
    } catch {}
    excluding = null;
  }
  async function addWL(s:any){
    adding=s.titleKey;
    try{
      const src = sourceFromUrl(s.seriesUrl) || s.chapters[0]?.source || "";
      const res=await fetch("/api/v1/reader/whitelist", withCsrf({method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key:s.titleKey, title:s.title, source:src, cover:s.cover, series_url:s.seriesUrl})}));
      if(!res.ok) throw new Error(await res.text());
      optimistic=new Set([...optimistic,s.titleKey]);
      toast("Added to whitelist","success");
    }catch(e:any){ toast(e?.message?.slice(0,200)||"Add failed","error"); } finally{ adding=null; }
  }
  async function doBookmark(s:any){
    const key = s.titleKey;
    if (bookmarked.has(key)) return;
    bookmarking = key;
    try{
      const ch = s.chapters?.[0];
      await saveBookmark({ title_key: key, chapter_number: Number(ch?.chapterNumber ?? ch?.chapter ?? 1), chapter_url: ch?.chapterUrl || ch?.url || s.seriesUrl || "", source: ch?.source || "", title: s.title, cover: s.cover || null });
      bookmarked = new Set([...bookmarked, key]);
      toast("Bookmarked","success");
      getBookmarks(1, 10).then(r => bookmarks = r).catch(()=>{});
    }catch(e:any){ toast(e?.message?.slice(0,200)||"Bookmark failed","error"); } finally{ bookmarking=null; }
  }
</script>

<div class="max-w-6xl mx-auto px-4 sm:px-6 py-8 overflow-x-hidden">
  {#if (!isOnline || data.error) && !offlineDismissed}
    <div class="mb-4 flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border text-sm {isOnline ? 'bg-amber-500/10 border-amber-500/20 text-amber-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}">
      <span class="flex items-center gap-2">{isOnline ? "⚠ Feed failed to load — showing cached data or try refreshing" : "● Offline — check your connection"}</span>
      <button onclick={()=>offlineDismissed=true} class="shrink-0 text-xs opacity-60 hover:opacity-100">✕</button>
    </div>
  {/if}
  {#if bookmarks.length > 0}
    <div class="mb-6">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-white/80">Continue reading</h2>
        <a href="/bookmarks" class="text-xs text-white/40 hover:text-white/70">View all →</a>
      </div>
      <div class="mt-3 flex gap-3 overflow-x-auto scrollbar-hide filter-scroll pb-1">
        {#each bookmarks.slice(0, 8) as bm}
          <a href={bm.chapter_url} target="_blank" rel="noopener noreferrer" class="group flex items-center gap-2.5 px-3 py-2 rounded-xl border border-white/[0.08] bg-[#18181b] hover:bg-[#27272a] hover:border-white/[0.14] transition-colors shrink-0 min-w-[200px] max-w-[260px]">
            {#if bm.cover}<img src={rewriteCoverUrl(bm.cover)||""} alt={bm.title} class="w-10 h-14 object-cover rounded bg-[#27272a] shrink-0" loading="lazy" />{:else}<div class="w-10 h-14 rounded bg-[#27272a] flex items-center justify-center text-zinc-500 text-[10px] shrink-0">—</div>{/if}
            <div class="min-w-0">
              <div class="text-xs font-medium leading-tight line-clamp-1 group-hover:text-white">{decodeHtml(bm.title || bm.title_key)}</div>
              <div class="text-[11px] text-zinc-500 mt-0.5">Ch. {bm.chapter_number} · {bm.source || "—"}</div>
              <div class="text-[10px] text-white/30 mt-0.5">Continue →</div>
            </div>
          </a>
        {/each}
      </div>
    </div>
  {/if}
  <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4 min-w-0">
    <div class="min-w-0">
      <h1 class="text-[28px] sm:text-[32px] font-semibold tracking-[-0.03em]">ManhwaScan</h1>
      <p class="text-sm text-zinc-400 mt-1">Latest updates — {filtered.length} series · {results.length} chapters</p>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span class="px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/[0.06] text-white/60">{stats.total} series</span>
      </div>
    </div>
      <div class="flex gap-2 w-full sm:w-auto items-center min-w-0">
      <input type="text" placeholder="Search title" value={q} oninput={(e)=>setQ((e.target as HTMLInputElement).value)} class="flex-1 min-w-0 sm:w-64 h-8 bg-[#18181b] border border-white/[0.08] rounded-full px-3.5 text-sm placeholder:text-zinc-500 focus:outline-none focus:border-white/20" />
      <div class="flex gap-1 shrink-0 items-center">
        <button onclick={()=>setSort('latest')} class={'min-h-0 h-8 px-3 text-xs rounded-full '+(sortBy==='latest'?'bg-white text-black':'bg-white/10 text-white/60')}>Latest</button>
        <button onclick={()=>setSort('rating')} class={'min-h-0 h-8 px-3 text-xs rounded-full '+(sortBy==='rating'?'bg-white text-black':'bg-white/10 text-white/60')}>Rating</button>
        <button onclick={()=>setSort('alpha')} class={'min-h-0 h-8 px-3 text-xs rounded-full '+(sortBy==='alpha'?'bg-white text-black':'bg-white/10 text-white/60')}>A–Z</button>
        <span class="w-px h-8 bg-white/10 mx-1"></span>
        <button onclick={()=>setView('grid')} class={'min-h-0 w-8 h-8 flex items-center justify-center rounded-full text-xs '+(view==='grid'?'bg-white text-black':'bg-white/10 text-white/60')}>⊞</button>
        <button onclick={()=>setView('list')} class={'min-h-0 w-8 h-8 flex items-center justify-center rounded-full text-xs '+(view==='list'?'bg-white text-black':'bg-white/10 text-white/60')}>☰</button>
      </div>
    </div>
  </div>

  {#if data.error}
    <div class="mt-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{data.error}</div>
  {:else if !feed}
    <div class="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {#each Array(6) as _}<div class="rounded-xl border border-white/10 bg-[#18181b] animate-pulse overflow-hidden"><div class="aspect-[3/4] bg-white/5"></div><div class="p-3 space-y-2"><div class="h-3 bg-white/5 rounded w-3/4"></div><div class="h-3 bg-white/5 rounded w-1/2"></div></div></div>{/each}
    </div>
  {:else if filtered.length===0}
    <div class="mt-10 flex flex-col items-center text-center py-8 rounded-xl border border-dashed border-white/10 bg-white/[0.02]">
      <div class="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-white/30 text-lg">∅</div>
      <p class="text-sm text-white/60 mt-3 font-medium">No results found</p>
      <p class="text-xs text-white/30 mt-1 max-w-xs">{q ? `No match for "${q}"` : "No series available"} — try adjusting your search or filters</p>
      {#if hasActiveFilters}<button onclick={clearFilters} class="mt-4 text-xs px-4 py-1.5 rounded-full bg-white text-black font-medium hover:bg-zinc-200 transition-colors">Clear filters</button>{/if}
    </div>
  {:else if view==="list"}
    <div class="mt-8 flex flex-col gap-3">
      {#each shown as s (s.titleKey + '|' + (s.seriesUrl || s.chapters?.[0]?.seriesUrl || '')) }}
        <div class="group flex gap-4 p-4 rounded-xl border border-white/[0.08] bg-[#18181b] hover:border-white/[0.14] hover:bg-[#27272a] transition-colors">
          <a href={s.seriesUrl || s.chapters[0]?.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="shrink-0">
            {#if s.cover}<img src={rewriteCoverUrl(s.cover)||""} alt={decodeHtml(s.title)} class="w-20 h-28 object-cover rounded-lg bg-[#27272a]" loading="lazy" />{:else}<div class="w-20 h-28 rounded-lg bg-[#27272a] flex items-center justify-center text-zinc-500 text-xs">—</div>{/if}
          </a>
          <div class="flex-1 min-w-0 flex flex-col">
            <a href={s.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="text-sm font-medium leading-tight hover:text-white">{decodeHtml(s.title)}</a>
            <div class="flex items-center gap-1.5 mt-1">
              {#if s.rating && Number(s.rating)>0}<span class="text-xs text-amber-300">★ {Number(s.rating).toFixed(1)}</span>{/if}
              {#each [...new Set(s.chapters.map((c:any)=>c.source))] as src}<span class={"text-[10px] px-1.5 py-0.5 rounded "+sourceChipClass(src as string)}>{src}</span>{/each}
              {#if s.genres?.length}<span class="text-[11px] text-zinc-500">· {s.genres.slice(0,4).join(" · ")}</span>{/if}
            </div>
            {#if s.description}<p class="text-[13px] text-zinc-400 line-clamp-3 mt-2 leading-relaxed">{decodeHtml(s.description)}</p>{:else}<p class="text-[11px] text-zinc-500 mt-1">—</p>{/if}
            <div class="flex gap-1 flex-wrap mt-3">
              {#each s.chapters.slice(0,5) as ch}
                {@const label=getChapterLabel(ch as any)}
                {#if label!=="?" }<a href={ch.chapterUrl||ch.url||"#"} target="_blank" rel="noopener noreferrer" class={"inline-flex items-center justify-center text-xs leading-none px-2.5 py-1 rounded transition-colors "+chapterSourceClass(ch.source)}>Ch. {label}</a>{/if}
              {/each}
            </div>
            <div class="mt-auto pt-3 flex gap-2">
              {#if s.isWhitelisted || optimistic.has(s.titleKey)}
                <span class="inline-flex items-center text-xs px-3 py-1 rounded bg-sky-500/15 text-sky-300 border border-sky-500/20">✓ Verified</span>
              {:else}
                <button onclick={()=>addWL(s)} disabled={adding===s.titleKey} class="text-xs px-3 py-1 rounded bg-white text-black hover:bg-zinc-200 disabled:opacity-50 font-medium transition-colors">{#if adding===s.titleKey}...{:else}+<span class="hidden sm:inline"> Add</span>{/if}</button>
              {/if}
              {#if bookmarked.has(s.titleKey)}
                <span class="inline-flex items-center text-xs px-3 py-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20">★ Saved</span>
              {:else}
                <button onclick={()=>doBookmark(s)} disabled={bookmarking===s.titleKey} class="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 transition-colors">{#if bookmarking===s.titleKey}...{:else}☆<span class="hidden sm:inline"> Bookmark</span>{/if}</button>
              {/if}
              {#if excluded.has(s.titleKey)}
                <span class="inline-flex items-center text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">✕</span>
              {:else}
                <button onclick={()=>excludeTitle(s.titleKey, s.title, s.source)} disabled={excluding===s.titleKey} class="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-50">{excluding===s.titleKey?"...":"✕"}</button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
    <div bind:this={sentinel} class="h-8"></div>
    {#if loadingMore}
      <div class="flex flex-col gap-3">
        {#each Array(2) as _}<div class="flex gap-4 p-4 rounded-xl border border-white/[0.08] bg-[#18181b] animate-pulse"><div class="w-20 h-28 rounded-lg bg-white/5 shrink-0"></div><div class="flex-1 space-y-2"><div class="h-4 bg-white/5 rounded w-3/4"></div><div class="h-3 bg-white/5 rounded w-1/2"></div><div class="h-16 bg-white/5 rounded"></div></div></div>{/each}
      </div>
    {:else if visible < filtered.length}<div class="text-center text-xs text-white/30 py-2">{visible} / {filtered.length} — scroll for more</div>{/if}
  {:else}
    <div class="mt-8 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {#each shown as s (s.titleKey + '|' + (s.seriesUrl || s.chapters?.[0]?.seriesUrl || ''))}
        <div class="group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#18181b] hover:border-white/15 transition-colors">
          <a href={s.seriesUrl || s.chapters[0]?.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="relative block aspect-[3/4] overflow-hidden bg-black">
            {#if s.cover}<img src={rewriteCoverUrl(s.cover)||""} alt={decodeHtml(s.title)} class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />{:else}<div class="absolute inset-0 bg-[#27272a] flex items-center justify-center text-zinc-500 text-xs">—</div>{/if}
            <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent"></div>
            <div class="absolute bottom-0 inset-x-0 p-3">
              <div class="font-medium text-sm leading-tight line-clamp-2 text-white drop-shadow">{decodeHtml(s.title)}</div>
              <div class="flex items-center gap-1 mt-1.5 flex-wrap">
                {#if s.rating && Number(s.rating)>0}<span class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-500/90 text-white">★ {Number(s.rating).toFixed(1)}</span>{/if}
                {#each [...new Set(s.chapters.map((c:any)=>c.source))] as src}<span class={"text-[9px] px-1.5 py-0.5 rounded backdrop-blur bg-white/15 text-white "+(src?"":"hidden")}>{src}</span>{/each}
              </div>
              {#if s.genres?.length}<p class="text-[10px] text-white/70 mt-1 line-clamp-1">{s.genres.slice(0,3).join(" · ")}</p>{/if}
            </div>
            {#if s.origin}<img src={"https://flagsapi.com/"+s.origin+"/flat/24.png"} alt={s.origin} class="absolute top-2 left-2 w-4 h-3 rounded-sm object-cover" loading="lazy" />{/if}
          </a>
          <div class="p-3 flex flex-col gap-2 flex-1">
            {#if s.description}<p class="text-[11px] text-zinc-400 line-clamp-2 leading-snug">{decodeHtml(s.description)}</p>{/if}
            <div class="flex gap-1 flex-wrap">
              {#each s.chapters.slice(0,3) as c}
                {#if getChapterLabel(c as any)!=="?" }<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded backdrop-blur bg-white/15 text-white" style="line-height:1">Ch. {getChapterLabel(c as any)}</span>{/if}
              {/each}
            </div>
            <div class="mt-auto pt-2 flex gap-2">
              {#if s.isWhitelisted || optimistic.has(s.titleKey)}
                <span class="inline-flex items-center text-[11px] px-2.5 py-1 rounded bg-sky-500/15 text-sky-300 border border-sky-500/20">✓ Verified</span>
              {:else}
                <button onclick={()=>addWL(s)} disabled={adding===s.titleKey} class="min-h-0 text-[11px] px-2.5 py-1 rounded bg-white text-black font-medium disabled:opacity-50">{#if adding===s.titleKey}...{:else}+<span class="hidden sm:inline"> Add WL</span>{/if}</button>
              {/if}
              {#if bookmarked.has(s.titleKey)}
                <span class="inline-flex items-center text-[11px] px-2.5 py-1 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20">★ Saved</span>
              {:else}
                <button onclick={()=>doBookmark(s)} disabled={bookmarking===s.titleKey} class="min-h-0 text-[11px] px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50">{#if bookmarking===s.titleKey}...{:else}☆<span class="hidden sm:inline"> Bookmark</span>{/if}</button>
              {/if}
              {#if !excluded.has(s.titleKey)}<button onclick={()=>excludeTitle(s.titleKey, s.title, s.source)} disabled={excluding===s.titleKey} class="ml-auto min-h-0 w-6 h-6 flex items-center justify-center rounded-full bg-white/5 text-white/40 hover:bg-red-500/20 hover:text-red-300 text-[10px] disabled:opacity-50">{excluding===s.titleKey?"...":"✕"}</button>{/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
    <div bind:this={sentinel} class="h-8"></div>
    {#if loadingMore}
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {#each Array(6) as _}<div class="rounded-xl border border-white/10 bg-[#18181b] animate-pulse overflow-hidden"><div class="aspect-[3/4] bg-white/5"></div><div class="p-3 space-y-2"><div class="h-3 bg-white/5 rounded w-3/4"></div><div class="h-3 bg-white/5 rounded w-1/2"></div></div></div>{/each}
      </div>
    {:else if visible < filtered.length}<div class="text-center text-xs text-white/30 py-2">{visible} / {filtered.length} — scroll for more</div>{/if}
  {/if}
</div>
