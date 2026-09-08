<script lang="ts">
  import { withCsrf } from "$lib/csrf";
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
  let msg = $state<string | null>(null);
  async function post(url: string, body?: any) {
    const res = await fetch(url, withCsrf({ method:"POST", headers: body?{"Content-Type":"application/json"}:{}, body: body?JSON.stringify(body):undefined }));
    const j = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
    return j;
  }
  async function doCron(){ try{ await post("/api/cron?action=update"); msg="Cron triggered"; setTimeout(()=>msg=null,3000); location.reload(); }catch(e:any){msg=e.message} }
  async function doRefresh(){ try{ const j:any = await post("/api/v1/health/refresh-voratoon"); msg=`Refreshed ${j?.data?.refreshed ?? 0} covers`; setTimeout(()=>msg=null,3000);}catch(e:any){msg=e.message} }
  async function doResync(){ try{ await post("/api/cron?action=enrich"); msg="Resync triggered"; setTimeout(()=>msg=null,3000);}catch(e:any){msg=e.message} }
  async function doClear(){ try{ await fetch("/api/v1/logs/errors", withCsrf({method:"DELETE"})); msg="Logs cleared"; setTimeout(()=>msg=null,2000); location.reload(); }catch(e:any){msg=e.message} }
  async function doRetryAll(){ try{ await post("/api/v1/failed-dispatches?action=retry-all"); msg="Retry-all triggered"; setTimeout(()=>msg=null,2000);}catch(e:any){msg=e.message} }
</script>
<div class="max-w-5xl mx-auto px-4 py-6 space-y-6">
  <h1 class="text-xl font-bold">Admin</h1>
  {#if data.error}<div class="p-3 bg-red-500/10 text-red-400 text-sm rounded">{data.error}</div>{/if}
  <!-- overview -->
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
    <div class="p-4 rounded-xl bg-[#18181b] border border-white/[0.08]"><div class="text-xs text-white/50">Whitelist</div><div class="text-lg font-bold">{whitelistCount}</div></div>
    <div class="p-4 rounded-xl bg-[#18181b] border border-white/[0.08]"><div class="text-xs text-white/50">Queue</div><div class="text-lg font-bold">{queueLen}</div></div>
    <div class="p-4 rounded-xl bg-[#18181b] border border-white/[0.08]"><div class="text-xs text-white/50">Health</div><div class="text-sm font-medium truncate">{health?.status ?? health?.overall ?? "-"}</div></div>
    <div class="p-4 rounded-xl bg-[#18181b] border border-white/[0.08]"><div class="text-xs text-white/50">Cron</div><div class="text-xs font-medium truncate {String(cronStatus?.outcome ?? cronStatus?.status ?? '').toLowerCase()==='error'?'text-red-400':'text-white'}">{cronStatus?.outcome ?? cronStatus?.status ?? "-"}</div></div>
  </div>
  {#if msg}<div class="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">{msg}</div>{/if}
  <!-- actions -->
  <div class="flex flex-wrap gap-2">
    <button onclick={doCron} class="min-h-0 text-xs px-3 py-1.5 rounded-full bg-white text-black font-medium">Trigger Cron</button>
    <button onclick={doRefresh} class="min-h-0 text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20">Refresh Voratoon</button>
    <button onclick={doResync} class="min-h-0 text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20">Resync Ratings</button>
    <button onclick={doRetryAll} class="min-h-0 text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20">Retry Failed All</button>
    <button onclick={doClear} class="min-h-0 text-xs px-3 py-1.5 rounded-full bg-red-500/20 text-red-300">Clear Errors</button>
  </div>
  <!-- cron status -->
  <div class="p-4 rounded-xl border {String(cronStatus?.outcome).toLowerCase()==='error'?'border-red-500/20 bg-red-500/5':'border-white/10 bg-white/5'}">
    <h2 class="text-sm font-semibold">Cron</h2>
    <p class="text-xs text-white/50 mt-1">Last: {cronStatus?.timestamp ?? cronStatus?.last_run ?? "-"} · {cronStatus?.matched ?? 0} matched / {cronStatus?.sent ?? 0} sent · outcome: <span class={String(cronStatus?.outcome).toLowerCase()==='error'?'text-red-400 font-medium':'text-white/70'}>{cronStatus?.outcome ?? "-"}</span></p>
  </div>
  <!-- health source -->
  {#if health?.sourceHealth || health?.sources || Array.isArray(health?.sourceHealth) || Array.isArray(health?.sources)}
    <div class="p-4 rounded-xl border border-white/10 bg-white/5">
      <h2 class="text-sm font-semibold">Source Health</h2>
      <div class="mt-2 grid gap-2">
        {#each (()=>{ const raw = health.sourceHealth ?? health.sources ?? []; if(Array.isArray(raw)) return raw.map((h:any,i:number)=>[h.source ?? h.name ?? `#${i+1}`, h] as const); return Object.entries(raw); })() as [src, h] }
          <div class="flex justify-between text-xs"><span class="text-white/70 capitalize">{src}</span><span class={String((h as any).status).toLowerCase().includes("healthy")||String((h as any).status).toLowerCase()==="ok"?"text-green-400":"text-amber-400"}>{String((h as any).status)}</span></div>
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
