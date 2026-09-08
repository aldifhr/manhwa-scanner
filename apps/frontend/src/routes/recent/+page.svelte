<script lang="ts">
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  let { data }: any = $props();
  let results: any[] = $derived(data?.feed?.data?.results ?? []);
  let grouped = $derived(results.length ? groupChapters(results as any) : []);
  let adding: string | null = $state(null);
  async function addWL(s: any) {
    adding = s.titleKey;
    try {
      const res = await fetch("/api/v1/reader/whitelist", withCsrf({ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key: s.titleKey, title: s.title, source: s.chapters[0]?.source, cover: s.cover, series_url: s.seriesUrl, origin: s.origin, genres: s.genres, description: s.description }) }));
      if (!res.ok) throw new Error(await res.text());
      alert("Added to whitelist");
    } catch(e:any){ alert(e?.message?.slice(0,300) || "Add WL failed"); } finally { adding=null; }
  }
</script>
<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Recent</h1>
  <p class="text-white/60 text-sm mt-1">Latest grouped feed — {grouped.length} series</p>
  {#if data.error}
    <div class="mt-4 p-3 rounded bg-red-500/10 text-red-400 text-sm">{data.error}</div>
  {:else if grouped.length === 0}
    <div class="mt-8 text-center text-white/40">No data</div>
  {:else}
    <div class="mt-4 flex flex-col gap-3">
      {#each grouped as s (s.titleKey)}
        <div class="flex gap-3 p-3 rounded-xl border border-white/10 bg-white/5">
          {#if s.cover}<img src={rewriteCoverUrl(s.cover)||""} alt={s.title} class="w-16 h-24 object-cover rounded" />{/if}
          <div class="flex-1 min-w-0">
            <a href={s.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="font-semibold text-sm truncate hover:text-white/80">{decodeHtml(s.title)}</a>
            <div class="flex gap-1 flex-wrap mt-1">{#each s.chapters.slice(0,5) as c}<a href={c.chapterUrl || c.url || "#"} target="_blank" rel="noopener noreferrer" class="text-[11px] px-2 py-1 bg-white/10 hover:bg-white/20 rounded">Ch. {getChapterLabel(c as any)} · {c.source}</a>{/each}</div>
            {#if s.description}<p class="text-[11px] text-white/55 line-clamp-2 mt-1">{decodeHtml(s.description)}</p>{/if}
            <button onclick={() => addWL(s)} disabled={adding===s.titleKey} class="min-h-0 mt-2 text-[11px] px-2.5 py-1 rounded-full bg-[var(--gold-accent)] text-black disabled:opacity-50">{adding===s.titleKey?"...":"+ Add WL"}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
