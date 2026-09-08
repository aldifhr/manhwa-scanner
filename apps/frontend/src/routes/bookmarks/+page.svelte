<script lang="ts">
  import { onMount } from "svelte";
  import { getBookmarks } from "$lib/api";
  let items: any[] = $state([]);
  let loading = $state(true);
  onMount(async () => {
    try { items = await getBookmarks(); } catch {} finally { loading = false; }
  });
</script>
<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Bookmarks</h1>
  {#if loading}<div class="mt-4 text-sm text-white/40">Loading...</div>
  {:else if items.length===0}<div class="mt-4 text-sm text-white/40">No bookmarks yet. Use Bookmark button on Home chapters or Recent.</div>
  {:else}
    <p class="text-white/60 text-sm mt-1">{items.length} bookmarks</p>
    <div class="mt-4 grid gap-3">
      {#each items as b}
        <a href={b.chapter_url} target="_blank" rel="noopener noreferrer" class="p-3 rounded border border-white/10 bg-white/5 flex gap-3">
          {#if b.cover}<img src={b.cover} alt={b.title} class="w-12 h-16 object-cover rounded" />{/if}
          <div class="text-sm"><div class="font-medium">{b.title ?? b.title_key}</div><div class="text-white/50 text-xs">Ch. {b.chapter_number} · {b.source}</div></div>
        </a>
      {/each}
    </div>
  {/if}
</div>
