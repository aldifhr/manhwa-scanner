<script lang="ts">
  let { data }: any = $props();
  let snap: any = $derived(data?.snap?.data ?? data?.snap ?? {});
  let queue: any = $derived(data?.queue?.data ?? data?.queue ?? {});
  let cron: any = $derived(data?.cron?.data ?? data?.cron ?? {});
</script>
<div class="max-w-4xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Admin</h1>
  {#if data.error}<div class="mt-3 p-3 bg-red-500/10 text-red-400 text-sm">{data.error}</div>{/if}
  <div class="grid grid-cols-2 gap-3 mt-4">
    <div class="p-4 rounded bg-white/5 border border-white/10"><div class="text-xs text-white/50">Whitelist</div><div class="text-lg font-bold">{snap?.whitelistCount ?? snap?.whitelist_count ?? "-"}</div></div>
    <div class="p-4 rounded bg-white/5 border border-white/10"><div class="text-xs text-white/50">Queue</div><div class="text-lg font-bold">{queue?.depth ?? queue?.queueLength ?? snap?.queueLength ?? "-"}</div></div>
  </div>
  <details class="mt-4"><summary class="text-xs text-white/30 cursor-pointer">raw snapshot</summary><pre class="mt-2 p-2 bg-white/5 rounded text-xs overflow-auto max-h-96">{JSON.stringify(snap, null, 2).slice(0,3000)}</pre></details>
  <details class="mt-2"><summary class="text-xs text-white/30 cursor-pointer">raw queue/cron</summary><pre class="mt-2 p-2 bg-white/5 rounded text-xs overflow-auto max-h-64">{JSON.stringify({queue, cron}, null, 2).slice(0,2000)}</pre></details>
</div>
