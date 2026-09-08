<script lang="ts">
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  import { toast } from "$lib/toast.svelte";
  let { data }: any = $props();
  let feed = $derived(data.feed);
  let results: any[] = $derived(feed?.data?.results ?? []);
  let groupedAll = $derived(results.length ? groupChapters(results as any) : []);
  let q = $state("");
  let filtered = $derived(q ? groupedAll.filter(s=> (s.title||"").toLowerCase().includes(q.toLowerCase())) : groupedAll);
  let adding = $state<string | null>(null);
  let optimistic = $state<Set<string>>(new Set());
  async function addWL(s:any){
    adding=s.titleKey;
    try{
      const res=await fetch("/api/v1/reader/whitelist", withCsrf({method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key:s.titleKey, title:s.title, source:s.chapters[0]?.source, cover:s.cover, series_url:s.seriesUrl})}));
      if(!res.ok) throw new Error(await res.text());
      optimistic=new Set([...optimistic,s.titleKey]);
      toast("Added to whitelist","success");
    }catch(e:any){ toast(e?.message?.slice(0,200)||"Add failed","error"); } finally{ adding=null; }
  }
</script>

<div class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
  <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
    <div>
      <h1 class="text-[28px] sm:text-[32px] font-semibold tracking-[-0.03em]">ManhwaScan</h1>
      <p class="text-sm text-zinc-400 mt-1">Latest updates — {filtered.length} series · {results.length} chapters</p>
    </div>
    <input type="text" placeholder="Search title" bind:value={q} class="w-full sm:w-64 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm placeholder:text-zinc-500 focus:outline-none focus:border-zinc-700" />
  </div>

  {#if data.error}
    <div class="mt-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{data.error}</div>
  {:else if !feed}
    <div class="mt-8 grid grid-cols-2 lg:grid-cols-3 gap-4">
      {#each Array(6) as _, i}<div class="h-44 rounded-xl bg-zinc-900 border border-zinc-800 animate-pulse"></div>{/each}
    </div>
  {:else if filtered.length===0}
    <div class="mt-12 text-center text-zinc-500 text-sm">No results{ q ? ` for "${q}"` : ""}</div>
  {:else}
    <div class="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each filtered as s (s.titleKey)}
        <div class="group flex gap-3 p-3 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900 transition-colors">
          <a href={s.seriesUrl || s.chapters[0]?.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="shrink-0">
            {#if s.cover}<img src={rewriteCoverUrl(s.cover)||""} alt={decodeHtml(s.title)} class="w-16 h-24 object-cover rounded-lg bg-zinc-800" loading="lazy" />{:else}<div class="w-16 h-24 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-500 text-xs">—</div>{/if}
          </a>
          <div class="flex-1 min-w-0 flex flex-col">
            <a href={s.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="text-sm font-medium leading-tight line-clamp-1 hover:text-white">{decodeHtml(s.title)}</a>
            <div class="flex gap-1 flex-wrap mt-2">
              {#each s.chapters.slice(0,3) as ch}
                {@const label=getChapterLabel(ch as any)}
                {#if label!=="?" }<a href={ch.chapterUrl||ch.url||"#"} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center text-[11px] leading-none px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300">Ch. {label}</a>{/if}
              {/each}
            </div>
            <div class="mt-auto pt-3">
              {#if s.isWhitelisted || optimistic.has(s.titleKey)}
                <span class="inline-flex items-center text-[11px] px-2.5 py-1 rounded-full bg-white text-black">✓ Added</span>
              {:else}
                <button onclick={()=>addWL(s)} disabled={adding===s.titleKey} class="text-[11px] px-3 py-1 rounded-full bg-white text-black hover:bg-zinc-200 disabled:opacity-50">{adding===s.titleKey ? "..." : "+ Add"}</button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
