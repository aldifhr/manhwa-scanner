<script lang="ts">
  let { data }: any = $props();
  let items: any[] = $derived(data?.data?.data ?? data?.data?.results ?? data?.data ?? []);
  let arr: any[] = $derived(Array.isArray(items) ? items : Array.isArray(data?.data) ? data.data : []);
  let isUnauthorized = $derived(data?.status === 401 || String(data?.error||"").toLowerCase().includes("unauthorized"));
</script>
<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Whitelist</h1>
  {#if data.error && !isUnauthorized}<div class="mt-3 p-3 bg-red-500/10 text-red-400 text-sm">{data.error}</div>{/if}
  {#if isUnauthorized}
    <div class="mt-4 p-4 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">Login required — <a href="/login?redirect=/whitelist" class="underline">login</a> to see whitelist</div>
  {:else}
    <p class="text-white/60 text-sm mt-1">{arr.length} titles</p>
    <div class="mt-4 grid gap-3">
      {#each arr.slice(0,30) as it}
        <div class="p-3 rounded border border-white/10 bg-white/5 flex gap-3">
          {#if it.cover}<img src={it.cover} alt={it.title} class="w-12 h-16 object-cover rounded" />{/if}
          <div class="text-sm"><div class="font-medium">{it.title ?? it.titleKey}</div><div class="text-white/50 text-xs">{it.source} · {it.titleKey}</div></div>
        </div>
      {/each}
      {#if arr.length===0}<div class="text-white/40 text-sm mt-6">Empty — no whitelist yet. Add from Home via + Add WL</div>{/if}
    </div>
  {/if}
</div>
