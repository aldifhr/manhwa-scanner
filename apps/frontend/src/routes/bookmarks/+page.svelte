<script lang="ts">
  import { onMount } from "svelte";
  import { getBookmarks, deleteBookmark } from "$lib/api";
  import { rewriteCoverUrl } from "$lib/utils";
  import { toast } from "$lib/toast.svelte";
  let items: any[] = $state([]);
  let loading = $state(true);
  async function load(){ loading=true; try{ items=await getBookmarks(); }catch{} finally{ loading=false; } }
  onMount(load);
  async function del(b:any){
    try{ await deleteBookmark(b.title_key, b.chapter_number); toast("Bookmark removed","success"); await load(); }catch(e:any){ toast(e.message,"error"); }
  }
  async function clearAll(){
    await Promise.all([...items].map(b=>deleteBookmark(b.title_key, b.chapter_number).catch(()=>{})));
    toast("Cleared","success"); await load();
  }
</script>
<div class="max-w-6xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Bookmarks</h1>
  {#if loading}<div class="mt-4 text-sm text-white/40">Loading...</div>
  {:else if items.length===0}<div class="mt-4 text-sm text-white/40">No bookmarks yet. Use Bookmark button on Home chapters or Recent.</div>
  {:else}
    <div class="flex items-center justify-between mt-1"><p class="text-white/60 text-sm">{items.length} bookmarks</p><button onclick={clearAll} class="min-h-0 text-xs px-3 py-1 rounded-full bg-red-500/10 text-red-300">Clear all</button></div>
    <div class="mt-4 grid gap-3">
      {#each items as b}
        <div class="p-3 rounded border border-white/10 bg-white/5 flex gap-3">
          <a href={b.chapter_url} target="_blank" rel="noopener noreferrer" class="flex gap-3 flex-1 min-w-0">
            {#if b.cover}<img src={rewriteCoverUrl(b.cover)||""} alt={b.title} class="w-12 h-16 object-cover rounded" loading="lazy" />{/if}
            <div class="text-sm"><div class="font-medium">{b.title ?? b.title_key}</div><div class="text-white/50 text-xs">Ch. {b.chapter_number} · {b.source}</div></div>
          </a>
          <button onclick={()=>del(b)} class="min-h-0 self-center text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20">Remove</button>
        </div>
      {/each}
    </div>
  {/if}
</div>
