<script lang="ts">
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  import { withCsrf } from "$lib/csrf";
  let { data }: any = $props();
  let feed = $derived(data.feed);
  let results: any[] = $derived(feed?.data?.results ?? []);
  let grouped = $derived(results.length ? groupChapters(results as any) : []);
  let adding = $state<string | null>(null);
  async function addWL(series: any) {
    adding = series.titleKey;
    try {
      // replicate Next useFeedActions: title_key snake_case + per-source
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
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      alert("Added to whitelist — check /whitelist");
    } catch (e: any) { alert(e?.message?.slice(0,300) || "Add WL failed (login required)"); }
    finally { adding = null; }
  }
</script>

<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-2xl sm:text-3xl font-bold tracking-tighter" style="font-family: 'Space Grotesk', sans-serif">ManhwaScan</h1>
  <p class="text-white/60 text-sm mt-1">Read manhwa, manga, and webtoon for free. Daily updates from multiple sources.</p>

  {#if data.error}
    <div class="mt-6 p-4 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{data.error}</div>
  {:else if !feed}
    <div class="mt-6 space-y-3">
      {#each Array(6) as _, i}
        <div class="h-28 rounded-xl bg-white/5 border border-white/10 animate-pulse"></div>
      {/each}
    </div>
  {:else if grouped.length === 0}
    <div class="mt-12 text-center text-white/50">No updates today — check Recent</div>
  {:else}
    <div class="mt-6 flex flex-col gap-3">
      {#each grouped as series (series.titleKey)}
        <div class="flex gap-4 p-4 rounded-2xl border border-[var(--gold-border)] bg-[var(--gold-surface)]">
          <a href={series.seriesUrl || series.chapters[0]?.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="shrink-0">
            {#if series.cover}
              <img src={rewriteCoverUrl(series.cover) || ""} alt={decodeHtml(series.title)} class="w-16 sm:w-20 h-24 sm:h-28 object-cover rounded-lg bg-white/5" loading="lazy" />
            {:else}
              <div class="w-16 sm:w-20 h-24 sm:h-28 rounded-lg bg-white/5 flex items-center justify-center text-white/30 text-xs">No cover</div>
            {/if}
          </a>
          <div class="flex-1 min-w-0">
            <a href={series.seriesUrl || "#"} target="_blank" rel="noopener noreferrer" class="text-[14px] font-semibold truncate text-white hover:text-white/80">{decodeHtml(series.title)}</a>
            <div class="flex gap-1 flex-wrap mt-1.5">
              {#each series.chapters.slice(0,4) as ch}
                {@const label = getChapterLabel(ch as any)}
                {#if label !== "?"}
                  <a href={ch.chapterUrl || ch.url || "#"} target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center text-[11px] font-semibold px-2 py-1 rounded bg-white/10 hover:bg-white/20 leading-none">Ch. {label} · {ch.source}</a>
                {/if}
              {/each}
            </div>
            {#if series.description}
              <p class="text-[11px] text-white/55 line-clamp-2 mt-1.5">{decodeHtml(series.description)}</p>
            {/if}
            <button onclick={() => addWL(series)} disabled={adding===series.titleKey} class="min-h-0 mt-2 text-[11px] px-2.5 py-1 rounded-full bg-[var(--gold-accent)] text-black hover:bg-[var(--gold-accent-hover)] disabled:opacity-50">{adding===series.titleKey ? "..." : "+ Add WL"}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
