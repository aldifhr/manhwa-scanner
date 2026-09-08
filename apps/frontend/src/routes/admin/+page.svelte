<script lang="ts">
  let { data }: any = $props();
  let snap: any = $derived(data?.snap?.data ?? data?.snap ?? {});
  let queue: any = $derived(data?.queue?.data ?? data?.queue ?? {});
  let cron: any = $derived(data?.cron?.data ?? data?.cron ?? {});
  let health: any = $derived(data?.health?.data ?? data?.health ?? {});
  let errors: any = $derived(data?.errors?.data?.results ?? data?.errors?.data ?? []);
  let failed: any = $derived(data?.failed?.data ?? data?.failed ?? {});
  let failedItems: any[] = $derived(failed?.results ?? failed?.data ?? (Array.isArray(failed)?failed:[]));
  let whitelistCount = $derived(snap?.whitelistCount ?? snap?.whitelist_count ?? health?.whitelistCount ?? "-");
  let queueLen = $derived(queue?.depth ?? queue?.queueLength ?? queue?.queue_length ?? snap?.queueLength ?? "-");
  let cronStatus: any = $derived(snap?.cronStatus ?? snap?.cron_status ?? cron ?? {});
</script>
<div class="max-w-5xl mx-auto px-4 py-6 space-y-6">
  <h1 class="text-xl font-bold">Admin</h1>
  {#if data.error}<div class="p-3 bg-red-500/10 text-red-400 text-sm rounded">{data.error}</div>{/if}
  <!-- overview -->
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
    <div class="p-4 rounded-xl bg-[var(--gold-surface)] border border-[var(--gold-border)]"><div class="text-xs text-white/50">Whitelist</div><div class="text-lg font-bold">{whitelistCount}</div></div>
    <div class="p-4 rounded-xl bg-[var(--gold-surface)] border border-[var(--gold-border)]"><div class="text-xs text-white/50">Queue</div><div class="text-lg font-bold">{queueLen}</div></div>
    <div class="p-4 rounded-xl bg-[var(--gold-surface)] border border-[var(--gold-border)]"><div class="text-xs text-white/50">Health</div><div class="text-sm font-medium truncate">{health?.status ?? health?.overall ?? "-"}</div></div>
    <div class="p-4 rounded-xl bg-[var(--gold-surface)] border border-[var(--gold-border)]"><div class="text-xs text-white/50">Cron</div><div class="text-xs font-medium truncate">{cronStatus?.outcome ?? cronStatus?.status ?? "-"}</div></div>
  </div>
  <!-- cron actions -->
  <div class="p-4 rounded-xl border border-white/10 bg-white/5">
    <h2 class="text-sm font-semibold">Cron</h2>
    <p class="text-xs text-white/50 mt-1">Last: {cronStatus?.timestamp ?? cronStatus?.last_run ?? "-"} · {cronStatus?.matched ?? 0} matched / {cronStatus?.sent ?? 0} sent</p>
  </div>
  <!-- health source -->
  {#if health?.sourceHealth || health?.sources}
    <div class="p-4 rounded-xl border border-white/10 bg-white/5">
      <h2 class="text-sm font-semibold">Source Health</h2>
      <div class="mt-2 grid gap-2">
        {#each Object.entries(health.sourceHealth ?? health.sources ?? {}) as [src, h] }
          <div class="flex justify-between text-xs"><span class="text-white/70">{src}</span><span class={String((h as any).status).toLowerCase().includes("ok")?"text-green-400":"text-amber-400"}>{String((h as any).status)}</span></div>
        {/each}
      </div>
    </div>
  {/if}
  <!-- failed dispatches -->
  <div class="p-4 rounded-xl border border-white/10 bg-white/5">
    <h2 class="text-sm font-semibold">Failed Dispatches ({failed?.total ?? failedItems.length})</h2>
    {#if failedItems.length===0}<p class="text-xs text-white/40 mt-2">None</p>
    {:else}
      <div class="mt-2 space-y-2">
        {#each failedItems.slice(0,10) as f}
          <div class="text-xs flex justify-between"><span class="truncate">{f.title ?? f.title_key} · {f.source}</span><span class="text-white/40">{String(f.error ?? "").slice(0,40)}</span></div>
        {/each}
      </div>
    {/if}
  </div>
  <!-- recent errors -->
  <div class="p-4 rounded-xl border border-white/10 bg-white/5">
    <h2 class="text-sm font-semibold">Recent Errors</h2>
    {#if !Array.isArray(errors) || errors.length===0}<p class="text-xs text-white/40 mt-2">No errors</p>
    {:else}
      <div class="mt-2 space-y-1">
        {#each errors.slice(0,5) as e}
          <div class="text-xs text-red-300 truncate">{e.message ?? e.error ?? JSON.stringify(e).slice(0,120)}</div>
        {/each}
      </div>
    {/if}
  </div>
</div>
