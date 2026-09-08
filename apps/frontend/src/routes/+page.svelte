<script lang="ts">
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  import { toast } from "$lib/toast.svelte";
  import { getOriginFlag } from "$lib/constants";
  let { data }: any = $props();
  let feed = $derived(data.feed);
  let results: any[] = $derived(feed?.data?.results ?? []);
  let groupedAll = $derived(results.length ? groupChapters(results as any) : []);
  let q = $state("");
  let grouped = $derived(
    q ? groupedAll.filter(s=> (s.title||"").toLowerCase().includes(q.toLowerCase())) : groupedAll
  );
  let adding = $state<string | null>(null);
  let optimistic = $state<Set<string>>(new Set());
  async function addWL(series: any) {
    adding = series.titleKey;
    try {
      const payload = {
        title_key: series.titleKey,
        title: series.title,
        source: series.chapters[0]?.source || "unknown",
        cover: series.cover,
        series_url: series.seriesUrl,
        seriesUrl: series.seriesUrl,
        origin: series.origin,
        genres: series.genres,
        description: series.description
      };
      const res = await fetch("/api/v1/reader/whitelist", withCsrf({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }));
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      optimistic = new Set([...optimistic, series.titleKey]);
      toast("Added to whitelist — check /whitelist", "success");
    } catch (e: any) { toast(e?.message?.slice(0,300) || "Add WL failed (login required)", "error"); }
    finally { adding = null; }
  }
</script>

<div class="max-w-5xl mx-auto px-4 py-6">
  <!-- hero -->
  <div class="relative overflow-hidden rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)] p-6 sm:p-8">
    <div class="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full opacity-10" style="background: radial-gradient(circle, rgba(250,204,21,0.5), transparent 60%)"></div>
    <h1 class="text-3xl sm:text-4xl font-bold tracking-[-0.04em]" style="font-family:'Space Grotesk', sans-serif">ManhwaScan</h1>
    <p class="text-white/60 text-sm sm:text-[15px] mt-2 max-w-2xl">Read manhwa, manga, and webtoon for free. Daily updates from multiple sources — curated, fast, no clutter.</p>
    <div class="mt-5 flex flex-col sm:flex-row gap-3">
      <input type="text" placeholder="Search title..." bind:value={q} class="flex-1 bg-black border border-white/10 rounded-full px-4 py-2 text-sm placeholder:text-white/30 focus:outline-none focus:border-[var(--gold-accent)]" />
      <span class="text-xs text-white/40 self-center">{grouped.length} / {groupedAll.length} series</span>
    </div>
  </div>

  <!-- stats -->
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
    {#each [
      {label:"Today's Updates", value: groupedAll.length},
      {label:"Total Sources", value: [...new Set(groupedAll.flatMap(s=>s.chapters.map(c=>c.source)))].length},
      {label:"WL", value: groupedAll.filter(s=>s.isWhitelisted).length},
      {label:"Search", value: q ? `"${q}"` : "All"}
    ] as stat}
      <div class="p-4 rounded-xl bg-[var(--gold-surface)] border border-[var(--gold-border)]">
        <div class="text-xs text-white/50">{stat.label}</div>
        <div class="text-lg font-bold truncate">{stat.value}</div>
      </div>
    {/each}
  </div>

  {#if data.error}
    <div class="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{data.error}</div>
  {:else if !feed}
    <div class="mt-6 grid gap-3">
      {#each Array(6) as _, i}
        <div class="h-32 rounded-2xl bg-white/5 border border-white/10 animate-pulse"></div>
      {/each}
    </div>
  {:else if grouped.length === 0}
    <div class="mt-12 text-center">
      <p class="text-white/60 text-sm">No updates{ q ? ` for "${q}"` : ""}</p>
      <a href="/recent" class="inline-block mt-3 text-xs px-3 py-1 rounded-full bg-white/10 hover:bg-white/20">View Recent →</a>
    </div>
  {:else}
    <div class="mt-6 flex flex-col gap-3">
      {#each grouped as series (series.titleKey)}
        <div class="group flex gap-4 p-4 rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)] hover:bg-[var(--gold-surface-hover)] hover:border-[var(--gold-border-hover)] transition-colors">
          <a href={series.seriesUrl || series.chapters[0]?.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="shrink-0">
            {#if series.cover}
              <img src={rewriteCoverUrl(series.cover) || ""} alt={decodeHtml(series.title)} class="w-20 h-28 sm:w-20 sm:h-28 object-cover rounded-lg bg-white/5 ring-1 ring-white/10 group-hover:scale-[1.02] transition-transform" loading="lazy" />
            {:else}
              <div class="w-20 h-28 rounded-lg bg-white/5 ring-1 ring-white/10 flex items-center justify-center text-white/30 text-xs">No cover</div>
            {/if}
          </a>
          <div class="flex-1 min-w-0 flex flex-col">
            <div class="flex items-start gap-2">
              {#if getOriginFlag(series.origin)}<img src={getOriginFlag(series.origin)} alt={series.origin} class="w-4 h-3 rounded-sm object-cover shrink-0 mt-1" loading="lazy" />{/if}
              <a href={series.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="text-[15px] font-semibold leading-tight hover:text-white/80 line-clamp-1">{decodeHtml(series.title)}</a>
            </div>
            <div class="flex flex-wrap gap-1 mt-2">
              {#each series.chapters.slice(0,4) as ch}
                {@const label = getChapterLabel(ch as any)}
                {#if label !== "?"}
                  <a href={ch.chapterUrl || ch.url || "#"} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center text-[11px] leading-none px-2 py-1 rounded-full bg-white/10 hover:bg-white/20">Ch. {label} · {ch.source}</a>
                {/if}
              {/each}
            </div>
            {#if series.genres?.length}<p class="text-[10px] text-white/40 mt-1.5 line-clamp-1">{series.genres.slice(0,3).join(" · ")}</p>{/if}
            {#if series.description}<p class="text-[11px] text-white/55 line-clamp-2 mt-1">{decodeHtml(series.description)}</p>{/if}
            <div class="mt-auto pt-2">
              {#if series.isWhitelisted || optimistic.has(series.titleKey)}
                <span class="min-h-0 inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-green-500/15 text-green-400 border border-green-500/20">✓ Added</span>
              {:else}
                <button onclick={() => addWL(series)} disabled={adding===series.titleKey} class="min-h-0 text-[11px] px-3 py-1 rounded-full bg-[var(--gold-accent)] text-black hover:bg-[var(--gold-accent-hover)] disabled:opacity-50">{adding===series.titleKey ? "..." : "+ Add WL"}</button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
