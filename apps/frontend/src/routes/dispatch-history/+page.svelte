<script lang="ts">
  import { onMount } from "svelte";
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { timeAgo } from "$lib/timeAgo";
  import { getOriginFlag } from "$lib/constants";
  let items: any[] = $state([]);
  let q = $state("");
  let source: string = $state("all");
  let page = $state(1);
  let total = $state(0);
  let loading = $state(true);
  async function load(){
    loading=true;
    try{
      const params = new URLSearchParams({ page: String(page), page_size:"50" });
      if (q) params.set("search", q);
      const res = await fetch(`/api/v1/dispatch-history?${params}`);
      const j:any = await res.json().catch(()=>({}));
      const d=j?.data ?? j;
      items = d?.results ?? d?.data ?? [];
      total = d?.total ?? items.length;
    }catch{} finally{ loading=false; }
  }
  onMount(load);
  let filtered = $derived(source==="all" ? items : items.filter((i:any)=>i.source===source));
</script>
<div class="max-w-4xl mx-auto px-4 py-6 space-y-4">
  <h1 class="text-xl font-bold">Dispatch History</h1>
  <div class="flex flex-wrap gap-2">
    <input type="text" placeholder="Search title..." bind:value={q} oninput={()=>{ page=1; setTimeout(load,300); }} class="flex-1 min-w-40 bg-black border border-white/10 rounded-full px-3 py-1.5 text-sm" />
    <button onclick={()=>{page=1; load()}} class="min-h-0 px-3 py-1 text-xs rounded-full bg-white/10">Search</button>
  </div>
  <div class="flex gap-2 flex-wrap">
    {#each ["all","ikiru","shinigami","voratoon"] as s}
      <button onclick={()=>{source=s;}} class={"min-h-0 px-3 py-1 text-xs rounded-full capitalize "+(source===s?"bg-[var(--gold-accent)] text-black":"bg-white/10")}>{s}</button>
    {/each}
  </div>
  <p class="text-xs text-white/40">{total} total · {filtered.length} shown · page {page}</p>
  {#if loading}<div class="text-sm text-white/40">Loading...</div>
  {:else if filtered.length===0}<div class="text-sm text-white/40">No history</div>
  {:else}
    <div class="space-y-2">
      {#each filtered as it}
        <div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
          <div class="w-9 h-12 shrink-0 rounded overflow-hidden bg-white/5">
            {#if it.cover}<img src={rewriteCoverUrl(it.cover)||""} alt={it.title} class="w-full h-full object-cover" loading="lazy" />{:else}<div class="w-full h-full flex items-center justify-center text-xs">{(it.title||"?").charAt(0)}</div>{/if}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium truncate">{decodeHtml(it.title||"")}</span>
              {#if it.origin && getOriginFlag(it.origin)}<img src={getOriginFlag(it.origin)} alt={it.origin} class="w-4 h-3 rounded-sm object-cover" />{/if}
            </div>
            <div class="flex items-center gap-2 text-xs text-white/50 mt-0.5">
              <span class="font-medium text-amber-300">Ch. {getChapterLabel(it as any)}</span>
              <span class="capitalize px-1.5 py-0.5 rounded bg-white/10 text-[10px]">{it.source}</span>
              <span>{timeAgo(it.sentAt || it.sent_at || "")}</span>
            </div>
          </div>
          {#if it.url || it.seriesUrl}<a href={it.url || it.seriesUrl} target="_blank" rel="noopener noreferrer" class="shrink-0 p-2 rounded text-white/40 hover:text-white">↗</a>{/if}
        </div>
      {/each}
    </div>
    <div class="flex gap-2">
      <button onclick={()=>{ if(page>1){page--; load();} }} disabled={page<=1} class="min-h-0 px-3 py-1 text-xs rounded-full bg-white/10 disabled:opacity-30">Prev</button>
      <button onclick={()=>{ page++; load(); }} class="min-h-0 px-3 py-1 text-xs rounded-full bg-white/10">Next</button>
    </div>
  {/if}
</div>
