<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { withCsrf } from "$lib/csrf";
  let { data }: any = $props();
  let cron: any = $derived(data?.cron?.data ?? data?.cron ?? {});
  let snap: any = $derived(data?.snap?.data ?? data?.snap ?? {});
  let health: any = $derived(data?.health?.data ?? data?.health ?? {});
  let cronStatus: any = $derived(cron?.cronStatus ?? cron?.cron_status ?? snap?.cronStatus ?? snap?.cron_status ?? cron ?? {});
  let msg = $state<string | null>(null);
  let loading = $state<string | null>(null);
  let refreshing = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  async function post(url: string, body?: any){
    loading = url;
    try{
      const res = await fetch(url, withCsrf({ method:"POST", headers: body?{"Content-Type":"application/json"}:{}, body: body?JSON.stringify(body):undefined }));
      const j = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      msg = j?.message || "Done";
      setTimeout(()=>msg=null,3000);
      return j;
    }catch(e:any){ msg = e.message; setTimeout(()=>msg=null,4000); throw e; } finally{ loading=null; }
  }
  async function doCron(){ await post("/api/cron?action=update"); location.reload(); }
  async function doEnrich(){ await post("/api/cron?action=enrich"); }
  async function doHealthCheck(){ await post("/api/v1/health/refresh-voratoon"); }
  let isError = $derived(String(cronStatus?.outcome ?? "").toLowerCase()==="error");
  onMount(() => {
    pollTimer = setInterval(async () => {
      try {
        refreshing = true;
        const res = await fetch(`/api/v1/queue/cron?_=${Date.now()}`);
        if (res.ok) {
          const j = await res.json().catch(()=>null);
          if (j?.data) cron = j.data;
        }
      } catch {} finally { refreshing = false; }
    }, 30_000);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });
</script>

<div class="max-w-4xl mx-auto px-4 py-6 space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-bold">Cron {#if refreshing}<span class="text-xs font-normal text-white/30">· refreshing…</span>{/if}</h1>
    <a href="/admin" class="text-xs text-white/40 hover:text-white/70">→ Admin</a>
  </div>

  {#if msg}<div class="p-2.5 rounded-lg text-sm border {msg.toLowerCase().includes('error')||msg.toLowerCase().includes('fail')?'bg-red-500/10 border-red-500/20 text-red-300':'bg-green-500/10 border-green-500/20 text-green-300'}">{msg}</div>{/if}

  <!-- status -->
  <div class="rounded-xl border p-5 {isError ? 'border-red-500/20 bg-red-500/5' : 'border-white/10 bg-white/5'}">
    <div class="flex items-center gap-2">
      <span class="w-2 h-2 rounded-full {isError ? 'bg-red-400' : 'bg-green-400'} animate-pulse"></span>
      <span class="text-sm font-semibold">{isError ? 'Error' : 'Healthy'}</span>
      <span class="text-xs px-2 py-0.5 rounded-full {isError ? 'bg-red-500/15 text-red-300' : 'bg-green-500/15 text-green-300'}">{cronStatus?.outcome ?? cronStatus?.status ?? 'unknown'}</span>
    </div>
    <div class="mt-4 grid grid-cols-3 gap-3 text-center">
      <div class="p-3 rounded-lg bg-black/30 border border-white/5"><div class="text-lg font-bold">{cronStatus?.matched ?? 0}</div><div class="text-[11px] text-white/40">Matched</div></div>
      <div class="p-3 rounded-lg bg-black/30 border border-white/5"><div class="text-lg font-bold">{cronStatus?.sent ?? 0}</div><div class="text-[11px] text-white/40">Sent</div></div>
      <div class="p-3 rounded-lg bg-black/30 border border-white/5"><div class="text-lg font-bold truncate text-xs leading-5">{cronStatus?.outcome ?? '-'}</div><div class="text-[11px] text-white/40">Outcome</div></div>
    </div>
    <div class="mt-4 space-y-1 text-xs text-white/50">
      <div>Last run: <span class="text-white/80">{cronStatus?.timestamp ?? cronStatus?.last_run ?? '-'}</span></div>
      {#if cronStatus?.duration}<div>Duration: <span class="text-white/80">{cronStatus.duration}ms</span></div>{/if}
      {#if cronStatus?.error}<div class="text-red-300">Error: {cronStatus.error}</div>{/if}
    </div>
  </div>

  <!-- actions -->
  <div class="rounded-xl border border-white/10 bg-white/5 p-4">
    <h2 class="text-sm font-semibold">Actions</h2>
    <p class="text-xs text-white/40 mt-1">Trigger cron jobs manually. Use sparingly — cron runs automatically on schedule.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button onclick={doCron} disabled={!!loading} class="min-h-0 text-xs px-4 py-2 rounded-full bg-white text-black font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors">
        {#if loading?.includes('action=update')}...{:else}▶ Trigger Update{/if}
      </button>
      <button onclick={doEnrich} disabled={!!loading} class="min-h-0 text-xs px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-50">↻ Enrich / Resync</button>
      <button onclick={doHealthCheck} disabled={!!loading} class="min-h-0 text-xs px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-50">♡ Health Check</button>
    </div>
  </div>

  <!-- source health -->
  {#if health?.sourceHealth || health?.sources}
    <div class="rounded-xl border border-white/10 bg-white/5 p-4">
      <h2 class="text-sm font-semibold">Source Health</h2>
      <div class="mt-3 grid gap-2">
        {#each (()=>{ const raw = health.sourceHealth ?? health.sources ?? []; if(Array.isArray(raw)) return raw.map((h:any,i:number)=>[h.source ?? h.name ?? `#${i+1}`, h] as const); return Object.entries(raw); })() as [src, h] }
          <div class="flex items-center justify-between p-2.5 rounded-lg bg-black/30 border border-white/5">
            <span class="text-sm capitalize text-white/70">{src}</span>
            <span class="text-xs px-2 py-0.5 rounded-full {String((h as any).status).toLowerCase().includes('healthy')||String((h as any).status).toLowerCase()==='ok'?'bg-green-500/15 text-green-300':'bg-amber-500/15 text-amber-300'}">{String((h as any).status)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- queue snapshot -->
  {#if snap?.queueLength !== undefined || snap?.queue?.depth !== undefined}
    <div class="rounded-xl border border-white/10 bg-white/5 p-4">
      <h2 class="text-sm font-semibold">Queue</h2>
      <p class="text-xs text-white/50 mt-1">Pending dispatches: <span class="text-white font-medium">{snap.queueLength ?? snap.queue?.depth ?? '-'}</span></p>
    </div>
  {/if}
</div>
