<script lang="ts">
  import { decodeHtml, rewriteCoverUrl, getChapterLabel } from "$lib/utils";
  import { groupChapters } from "$lib/groupChapters";
  let { data }: any = $props();
  let results: any[] = $derived(data?.feed?.data?.results ?? []);
  let grouped = $derived(results.length ? groupChapters(results as any) : []);
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
            <div class="font-semibold text-sm truncate">{decodeHtml(s.title)}</div>
            <div class="flex gap-1 flex-wrap mt-1">{#each s.chapters.slice(0,5) as c}<span class="text-[11px] px-2 py-1 bg-white/10 rounded">Ch. {getChapterLabel(c as any)}</span>{/each}</div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
