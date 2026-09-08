<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  import { toast } from "$lib/toast.svelte";
  import { getOriginFlag } from "$lib/constants";
  import { chapterSourceClass } from "$lib/styles";
  import { saveBookmark } from "$lib/api";
  let { data }: any = $props();
  let results: any[] = $derived(data?.feed?.data?.results ?? []);
  let groupedAll = $derived(results.length ? groupChapters(results as any) : []);
  let q = $state("");
  let sourceFilter: string | null = $state(null);
  let countryFilter: string | null = $state(null);
  let wlFilter: "all"|"wl"|"non" = $state("all");
  let groupedMode = $state(true);
  let sortBy: "latest"|"rating"|"alpha" = $state("latest");
  let refreshing = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let excluded = $state<Set<string>>(new Set());
  let excluding: string | null = $state(null);
  let showTop = $state(false);
  let onScroll: () => void;
  // Restore filters from localStorage
  onMount(()=>{
    onScroll = () => showTop = window.scrollY > 400;
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    const p = new URLSearchParams(location.search);
    if (p.get("q")) q = p.get("q")!;
    if (p.get("source")) sourceFilter = p.get("source");
    const c = p.get("country");
    if (c === "korean" || c === "chinese") countryFilter = c;
    const w = p.get("wl");
    if (w === "wl" || w === "non") wlFilter = w;
    if (p.get("view") === "flat") groupedMode = false;
    const s = p.get("sort");
    if (s === "rating" || s === "alpha") sortBy = s;
    // Fallback to localStorage if URL has no params
    if (!p.toString()) {
      try {
        const saved = localStorage.getItem("recent_filters");
        if (saved) {
          const f = JSON.parse(saved);
          q = f.q || "";
          sourceFilter = f.sourceFilter || null;
          countryFilter = f.countryFilter || null;
          wlFilter = f.wlFilter || "all";
          groupedMode = f.groupedMode !== false;
          sortBy = f.sortBy || "latest";
        }
      } catch {}
    }
    pollTimer = setInterval(async () => {
      try {
        refreshing = true;
        const res = await fetch(`/api/v1/reader/rss?limit=1000&group=false&_=${Date.now()}`);
        if (res.ok) {
          const json = await res.json();
          if (json?.data?.results) {
            data = { feed: json, error: null };
          }
        }
      } catch {
        // silent fail on poll
      } finally {
        refreshing = false;
      }
    }, 30_000);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (onScroll) window.removeEventListener("scroll", onScroll);
  });
  function toTop(){ window.scrollTo({ top: 0, behavior: "smooth" }); }
  // Persist filters to localStorage
  function saveFilters() {
    try {
      localStorage.setItem("recent_filters", JSON.stringify({
        q, sourceFilter, countryFilter, wlFilter, groupedMode, sortBy
      }));
    } catch {}
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
  function syncUrl(){
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (sourceFilter) p.set("source", sourceFilter);
    if (countryFilter) p.set("country", countryFilter);
    if (wlFilter !== "all") p.set("wl", wlFilter);
    if (!groupedMode) p.set("view", "flat");
    if (sortBy !== "latest") p.set("sort", sortBy);
    const qs = p.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
    saveFilters();
  }
  function setQ(v: string){ q = v; syncUrl(); }
  function setSource(v: string | null){ sourceFilter = v; syncUrl(); }
  function setCountry(v: string | null){ countryFilter = v; syncUrl(); }
  function setWl(v: "all"|"wl"|"non"){ wlFilter = v; syncUrl(); }
  function setGrouped(v: boolean){ groupedMode = v; syncUrl(); }
  function setSort(v: "latest"|"rating"|"alpha"){ sortBy = v; syncUrl(); }
  function clearFilters(){ q=""; sourceFilter=null; countryFilter=null; wlFilter="all"; sortBy="latest"; syncUrl(); }
  let hasActiveFilters = $derived(!!q || !!sourceFilter || !!countryFilter || wlFilter!=="all" || sortBy!=="latest");
  function sortGrouped(arr: any[]){
    if (sortBy==="rating") return [...arr].sort((a,b)=> (Number(b.rating)||0) - (Number(a.rating)||0));
    if (sortBy==="alpha") return [...arr].sort((a,b)=> (a.title||"").localeCompare(b.title||""));
    return [...arr].sort((a,b)=>{
      const da = a.chapters?.[0]?.sentAt || a.sentAt || "";
      const db = b.chapters?.[0]?.sentAt || b.sentAt || "";
      return db.localeCompare(da);
    });
  }
  function sortFlat(arr: any[]){
    if (sortBy==="rating") return [...arr].sort((a,b)=> (Number(b.rating)||0) - (Number(a.rating)||0));
    if (sortBy==="alpha") return [...arr].sort((a,b)=> (a.title||"").localeCompare(b.title||""));
    return [...arr].sort((a,b)=> (b.sentAt||"").localeCompare(a.sentAt||""));
  }
  let sources: string[] = $derived([...new Set(groupedAll.flatMap(s=>s.chapters.map(c=>c.source)))].sort());
  let flatFiltered = $derived(sortFlat(results.filter((r:any)=>{
    if (q && !(r.title||"").toLowerCase().includes(q.toLowerCase())) return false;
    if (sourceFilter && r.source!==sourceFilter) return false;
    const o=(r.origin||"").toLowerCase();
    if (countryFilter==="korean" && o!=="kr" && o!=="korean") return false;
    if (countryFilter==="chinese" && o!=="cn" && o!=="chinese") return false;
    if (wlFilter==="wl" && !r.isWhitelisted) return false;
    if (wlFilter==="non" && r.isWhitelisted) return false;
    if (excluded.has(r.titleKey)) return false;
    return true;
  })));
  let filtered = $derived(groupedMode ? sortGrouped(groupedAll.filter(s=>{
    if (q && !(s.title||"").toLowerCase().includes(q.toLowerCase())) return false;
    if (sourceFilter && !s.chapters.some(c=>c.source===sourceFilter)) return false;
    if (countryFilter) {
      const o=(s.origin||"").toLowerCase();
      if (countryFilter==="korean" && o!=="kr" && o!=="korean") return false;
      if (countryFilter==="chinese" && o!=="cn" && o!=="chinese") return false;
    }
    if (wlFilter==="wl" && !s.isWhitelisted) return false;
    if (wlFilter==="non" && s.isWhitelisted) return false;
    if (excluded.has(s.titleKey)) return false;
    return true;
  })) : []);
  let visible = $state(30);
  let loadingMore = $state(false);
  let grouped = $derived(groupedMode ? filtered.slice(0, visible) : []);
  let flatVisible = $derived(!groupedMode ? flatFiltered.slice(0, visible) : []);
  // reset visible when filters/sort/mode change
  $effect(()=>{ void filtered.length; void flatFiltered.length; void groupedMode; void sortBy; void q; visible=30; });
  let adding: string | null = $state(null);
  let optimistic = $state<Set<string>>(new Set());
  let bookmarking: string | null = $state(null);
  let bookmarked = $state<Set<string>>(new Set());
  function sourceFromUrl(url: string): string {
    if (!url) return "";
    const h = url.toLowerCase();
    if (h.includes("ikiru")) return "ikiru";
    if (h.includes("shinigami")) return "shinigami";
    if (h.includes("voratoon")) return "voratoon";
    return "";
  }
  async function addWL(s: any) {
    adding = s.titleKey;
    try {
      const src = sourceFromUrl(s.seriesUrl) || s.chapters[0]?.source || "";
      const res = await fetch("/api/v1/reader/whitelist", withCsrf({ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key: s.titleKey, title: s.title, source: src, cover: s.cover, series_url: s.seriesUrl, origin: s.origin, genres: s.genres, description: s.description }) }));
      if (!res.ok) throw new Error(await res.text());
      optimistic = new Set([...optimistic, s.titleKey]);
      toast("Added to whitelist", "success");
    } catch(e:any){ toast(e?.message?.slice(0,300) || "Add WL failed", "error"); } finally { adding=null; }
  }
  async function doBookmark(s: any){
    const key = s.titleKey;
    if (bookmarked.has(key)) return;
    bookmarking = key;
    try{
      const ch = s.chapters?.[0];
      await saveBookmark({ title_key: key, chapter_number: Number(ch?.chapterNumber ?? ch?.chapter ?? 1), chapter_url: ch?.chapterUrl || ch?.url || s.seriesUrl || "", source: ch?.source || "", title: s.title, cover: s.cover || null });
      bookmarked = new Set([...bookmarked, key]);
      toast("Bookmarked","success");
    }catch(e:any){ toast(e?.message?.slice(0,200)||"Bookmark failed","error"); } finally{ bookmarking=null; }
  }
  async function doBookmarkFlat(ch: any){
    const key = `${ch.titleKey}:${ch.chapter}`;
    if (bookmarked.has(key)) return;
    bookmarking = key;
    try{
      await saveBookmark({ title_key: ch.titleKey, chapter_number: Number(ch.chapterNumber ?? ch.chapter ?? 1), chapter_url: ch.chapterUrl || ch.url || "", source: ch.source || "", title: ch.title, cover: ch.cover || null });
      bookmarked = new Set([...bookmarked, key]);
      toast("Bookmarked","success");
    }catch(e:any){ toast(e?.message?.slice(0,200)||"Bookmark failed","error"); } finally{ bookmarking=null; }
  }
  function btnActive(active: boolean){ return active ? "bg-white text-black" : "bg-white/[0.06] text-white/70 hover:bg-white/10"; }
  let sentinel: HTMLDivElement | null = $state(null);
  $effect(()=>{
    if (!sentinel) return;
    const io = new IntersectionObserver((entries)=>{
      const total = groupedMode ? filtered.length : flatFiltered.length;
      if (entries[0]?.isIntersecting && visible < total){
        loadingMore = true;
        setTimeout(()=>{ visible = Math.min(visible+30, total); loadingMore = false; }, 300);
      }
    }, { rootMargin: "400px" });
    io.observe(sentinel);
    return ()=>io.disconnect();
  });
</script>
<div class="max-w-6xl mx-auto px-4 sm:px-6 py-8 overflow-x-hidden">
  <h1 class="text-xl font-bold">Recent</h1>
  <p class="text-white/60 text-sm mt-1">{groupedMode ? `Grouped — ${grouped.length} / ${filtered.length} series` : `Flat — ${flatVisible.length} / ${flatFiltered.length} ch`} · total {groupedAll.length} series / {results.length} ch {#if !refreshing}<span class="text-white/30"> · auto-refresh 30s</span>{/if}</p>
  <!-- search + sort -->
  <div class="mt-3 flex flex-col sm:flex-row gap-2 min-w-0">
    <input type="text" placeholder="Search title..." value={q} oninput={(e)=>setQ((e.target as HTMLInputElement).value)} class="flex-1 min-w-0 h-8 bg-[#18181b] border border-white/[0.08] rounded-full px-3.5 text-sm placeholder:text-white/30 focus:outline-none focus:border-white/20" />
    <div class="flex gap-1 shrink-0">
      <button onclick={()=>setSort("latest")} class={"min-h-0 px-3 py-1.5 text-xs rounded-full "+(sortBy==="latest"?"bg-white text-black":"bg-white/10 text-white/60")}>Latest</button>
      <button onclick={()=>setSort("rating")} class={"min-h-0 px-3 py-1.5 text-xs rounded-full "+(sortBy==="rating"?"bg-white text-black":"bg-white/10 text-white/60")}>Rating</button>
      <button onclick={()=>setSort("alpha")} class={"min-h-0 px-3 py-1.5 text-xs rounded-full "+(sortBy==="alpha"?"bg-white text-black":"bg-white/10 text-white/60")}>A–Z</button>
    </div>
  </div>
  <!-- grouped toggle -->
  <div class="mt-3 inline-flex rounded-full bg-white/5 border border-white/10 p-1">
    <button onclick={()=>setGrouped(true)} class={"min-h-0 px-4 py-1 text-xs rounded-full "+(groupedMode?"bg-white text-black":"text-white/60")}>Grouped</button>
    <button onclick={()=>setGrouped(false)} class={"min-h-0 px-4 py-1 text-xs rounded-full "+(!groupedMode?"bg-white text-black":"text-white/60")}>Flat</button>
  </div>
  <!-- filters -->
  <div class="mt-3 flex flex-col gap-2">
    <div class="flex flex-wrap gap-2">
      <button onclick={()=>setWl("all")} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(wlFilter==="all")}>All</button>
      <button onclick={()=>setWl("non")} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(wlFilter==="non")}>Non-WL</button>
      <button onclick={()=>setWl("wl")} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(wlFilter==="wl")}>WL</button>
    </div>
    <div class="flex flex-wrap gap-2">
      <button onclick={()=>setCountry(null)} class={"min-h-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full "+btnActive(countryFilter===null)}>All Countries</button>
      <button onclick={()=>setCountry(countryFilter==="korean"?null:"korean")} class={"min-h-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full "+btnActive(countryFilter==="korean")}>Korea</button>
      <button onclick={()=>setCountry(countryFilter==="chinese"?null:"chinese")} class={"min-h-0 inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-full "+btnActive(countryFilter==="chinese")}>China</button>
      <span class="w-px h-4 bg-white/10 self-center mx-1"></span>
      <button onclick={()=>setSource(null)} class={"min-h-0 px-3 py-1 text-xs rounded-full "+btnActive(sourceFilter===null)}>All Sources</button>
      {#each sources as s}
        <button onclick={()=>setSource(sourceFilter===s?null:s)} class={"min-h-0 px-3 py-1 text-xs rounded-full capitalize "+btnActive(sourceFilter===s)}>{s}</button>
      {/each}
    </div>
  </div>
  {#if data.error}
    <div class="mt-4 p-3 rounded bg-red-500/10 text-red-400 text-sm">{data.error}</div>
  {:else if (groupedMode ? filtered.length===0 : flatFiltered.length===0)}
    <div class="mt-10 flex flex-col items-center text-center py-8 rounded-xl border border-dashed border-white/10 bg-white/[0.02]">
      <div class="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-white/30 text-lg">∅</div>
      <p class="text-sm text-white/60 mt-3 font-medium">No results found</p>
      <p class="text-xs text-white/30 mt-1 max-w-xs">{q ? `No match for "${q}"` : "No series match the current filters"} — try adjusting your filters or search</p>
      {#if hasActiveFilters}<button onclick={clearFilters} class="mt-4 text-xs px-4 py-1.5 rounded-full bg-white text-black font-medium hover:bg-zinc-200 transition-colors">Clear filters</button>{/if}
    </div>
  {:else if groupedMode}
    <div class="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {#each grouped as s (s.titleKey + '|' + (s.source || s.chapters?.[0]?.source || ''))}
        <div class="group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#18181b] hover:border-white/15 transition-colors">
          <a href={s.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="relative block aspect-[3/4] overflow-hidden bg-black">
            {#if s.cover}<img src={rewriteCoverUrl(s.cover)||""} alt={s.title} class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />{:else}<div class="absolute inset-0 bg-[#27272a] flex items-center justify-center text-zinc-500 text-xs">—</div>{/if}
            <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent"></div>
            <div class="absolute bottom-0 inset-x-0 p-3">
              <div class="font-medium text-sm leading-tight line-clamp-2 text-white drop-shadow">{decodeHtml(s.title)}</div>
              <div class="flex gap-1 flex-wrap mt-1.5">{#if s.rating && Number(s.rating)>0}<span class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-500/90 text-white">★ {Number(s.rating).toFixed(1)}</span>{/if}{#each s.chapters.slice(0,3) as c}<span class={"inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded backdrop-blur bg-white/15 text-white "+chapterSourceClass(c.source)} style="line-height:1">Ch. {getChapterLabel(c as any)}</span>{/each}</div>
              {#if s.genres?.length}<p class="text-[10px] text-white/70 mt-1 line-clamp-1">{s.genres.slice(0,3).join(" · ")}</p>{/if}
            </div>
            {#if getOriginFlag(s.origin)}<img src={getOriginFlag(s.origin)} alt={s.origin} class="absolute top-2 left-2 w-4 h-3 rounded-sm object-cover" loading="lazy" />{/if}
          </a>
          <div class="p-3 flex flex-col gap-2 flex-1">
            {#if s.description}<p class="text-[11px] text-zinc-400 line-clamp-2 leading-snug">{decodeHtml(s.description)}</p>{/if}
            <div class="flex gap-2 mt-auto pt-1">
              {#if s.isWhitelisted || optimistic.has(s.titleKey)}
                <span class="min-h-0 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-sky-500/15 text-sky-300 border border-sky-500/20">✓ Verified</span>
              {:else}
                <button onclick={() => addWL(s)} disabled={adding===s.titleKey} class="min-h-0 text-[11px] px-2.5 py-1 rounded bg-white text-black font-medium disabled:opacity-50">{#if adding===s.titleKey}...{:else}+<span class="hidden sm:inline"> Add WL</span>{/if}</button>
              {/if}
              {#if bookmarked.has(s.titleKey)}
                <span class="min-h-0 inline-flex items-center text-[11px] px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">★ Saved</span>
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
  {:else}
    <div class="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      {#each flatVisible as ch (ch.chapterUrl || (ch.titleKey + '|' + ch.chapter + '|' + ch.source))}
        <div class="group flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#18181b] hover:border-white/15 transition-colors">
          <a href={ch.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="relative block aspect-[3/4] overflow-hidden bg-black">
            {#if ch.cover}<img src={rewriteCoverUrl(ch.cover)||""} alt={ch.title} class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />{:else}<div class="absolute inset-0 bg-[#27272a] flex items-center justify-center text-zinc-500 text-xs">—</div>{/if}
            <div class="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent"></div>
            <div class="absolute bottom-0 inset-x-0 p-3">
              <div class="font-medium text-sm leading-tight line-clamp-2 text-white drop-shadow">{decodeHtml(ch.title)}</div>
              <div class="flex gap-1 flex-wrap mt-1.5">
                <span class={"inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded backdrop-blur bg-white/15 text-white"}>Ch. {getChapterLabel(ch as any)}</span>
                {#if ch.type}<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-white/15 backdrop-blur text-white capitalize">{ch.type}</span>{/if}
                {#if ch.rating && Number(ch.rating)>0}<span class="inline-flex items-center justify-center text-[10px] leading-none px-1.5 py-0.5 rounded bg-amber-500/90 text-white">★ {Number(ch.rating).toFixed(1)}</span>{/if}
              </div>
              {#if ch.genres?.length}<p class="text-[10px] text-white/70 mt-1 line-clamp-1">{ch.genres.slice(0,3).join(" · ")}</p>{/if}
            </div>
            {#if getOriginFlag(ch.origin)}<img src={getOriginFlag(ch.origin)} alt={ch.origin} class="absolute top-2 left-2 w-4 h-3 rounded-sm object-cover" />{/if}
            {#if ch.isWhitelisted}<span class="absolute top-2 right-2 inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-sky-500/90 text-white">✓ Verified</span>{/if}
          </a>
          <div class="p-3 flex flex-col gap-2 flex-1">
            {#if ch.description}<p class="text-[11px] text-zinc-400 line-clamp-2 leading-snug">{decodeHtml(ch.description)}</p>{/if}
            <div class="flex gap-2 mt-auto pt-1">
              {#if ch.isWhitelisted}
                <span class="inline-flex items-center text-[11px] px-2.5 py-1 rounded bg-sky-500/15 text-sky-300 border border-sky-500/20">✓ Verified</span>
              {:else}
                <button onclick={()=>addWL({titleKey:ch.titleKey,title:ch.title,source:ch.source,cover:ch.cover,seriesUrl:ch.seriesUrl,chapters:[ch]})} disabled={adding===ch.titleKey} class="min-h-0 text-[11px] px-2.5 py-1 rounded bg-white text-black font-medium disabled:opacity-50">{#if adding===ch.titleKey}...{:else}+{/if}</button>
              {/if}
              <a href={ch.chapterUrl || ch.url || "#"} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center text-[11px] px-2.5 py-1 bg-white text-black rounded font-medium hover:bg-zinc-200">Read</a>
              {#if bookmarked.has(`${ch.titleKey}:${ch.chapter}`)}
                <span class="inline-flex items-center text-[11px] px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">★ Saved</span>
              {:else}
                <button onclick={()=>doBookmarkFlat(ch)} disabled={bookmarking===`${ch.titleKey}:${ch.chapter}`} class="min-h-0 text-[11px] px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50">{#if bookmarking===`${ch.titleKey}:${ch.chapter}`}...{:else}☆<span class="hidden sm:inline"> Bookmark</span>{/if}</button>
              {/if}
              {#if excluded.has(ch.titleKey)}
                <span class="min-h-0 inline-flex items-center text-[11px] px-2.5 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">✕ Excluded</span>
              {:else}
                <button onclick={()=>excludeTitle(ch.titleKey, ch.title, ch.source)} disabled={excluding===ch.titleKey} class="min-h-0 text-[11px] px-2.5 py-1 rounded bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-50">{excluding===ch.titleKey?"...":"✕ Exclude"}</button>
              {/if}
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
    {:else if visible < flatFiltered.length}<div class="text-center text-xs text-white/30 py-2">{visible} / {flatFiltered.length} — scroll for more</div>{/if}
  {/if}
  {#if showTop}
    <button onclick={toTop} class="fixed bottom-6 right-6 z-30 w-10 h-10 rounded-full bg-white text-black shadow-lg flex items-center justify-center text-sm hover:bg-zinc-200 transition-colors" aria-label="Back to top">↑</button>
  {/if}
</div>
