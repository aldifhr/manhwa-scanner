<script lang="ts">
  import { withCsrf } from "$lib/csrf";
  import { rewriteCoverUrl } from "$lib/utils";
  import { toast } from "$lib/toast.svelte";
  let { data }: any = $props();
  let raw:any = $derived(data?.data?.data ?? data?.data ?? {});
  let serverArr:any[] = $derived(Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.data) ? raw.data : []);
  let arr:any[] = $state([]);
  $effect(()=>{ arr = [...serverArr]; });
  let q=$state("");
  let adding=$state(false);
  async function add(){
    if(!q.trim()) return;
    adding=true;
    const key=q.trim();
    try{
      const res=await fetch("/api/v1/excluded-titles", withCsrf({method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key: key, title: key })}));
      if(!res.ok) throw new Error(await res.text());
      arr = [...arr, { title: key, title_key: key }];
      q="";
      toast("Excluded","success");
    }catch(e:any){ toast(e.message,"error"); } finally{ adding=false; }
  }
  async function del(it:any){
    const key=it.title_key ?? it.titleKey ?? it.title;
    try{
      const res=await fetch("/api/v1/excluded-titles", withCsrf({method:"DELETE", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title_key: key })}));
      if(!res.ok) throw new Error(await res.text());
      arr = arr.filter((x:any)=>(x.title_key ?? x.titleKey ?? x.title) !== key);
      toast("Removed","success");
    }catch(e:any){ toast(e.message,"error"); }
  }
</script>
<div class="max-w-6xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold">Exclude List</h1>
  <p class="text-white/60 text-sm mt-1">{arr.length} titles · hidden from feed</p>
  <div class="mt-4 flex gap-2">
    <input bind:value={q} placeholder="title_key or title" class="flex-1 bg-[#18181b] border border-white/[0.08] rounded-lg px-3 py-2 text-sm" />
    <button onclick={add} disabled={adding||!q.trim()} class="min-h-0 px-4 py-2 text-sm rounded-lg bg-white text-black font-medium disabled:opacity-50">Add</button>
  </div>
  {#if data.error}<div class="mt-3 p-2 bg-red-500/10 text-red-400 text-sm rounded">{data.error}</div>{/if}
  <div class="mt-4 grid gap-2">
    {#each arr as it}
      <div class="flex items-center gap-3 p-3 rounded border border-white/10 bg-white/5">
        {#if it.cover}<img src={rewriteCoverUrl(it.cover)||""} alt={it.title} class="w-12 h-16 object-cover rounded shrink-0" loading="lazy" />{/if}
        <div class="text-sm flex-1 min-w-0"><div class="font-medium truncate">{it.title ?? it.title_key}</div><div class="text-white/40 text-xs truncate">{it.title_key ?? it.titleKey}</div></div>
        <button onclick={()=>del(it)} class="min-h-0 shrink-0 text-xs px-2 py-1 rounded bg-red-500/20 text-red-300">Remove</button>
      </div>
    {/each}
    {#if arr.length===0}<div class="text-white/40 text-sm mt-4">Empty</div>{/if}
  </div>
</div>
