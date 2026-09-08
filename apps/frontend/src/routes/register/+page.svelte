<script lang="ts">
  let { data }: any = $props();
</script>
<div class="max-w-6xl mx-auto px-4 py-6">
  <h1 class="text-xl font-bold capitalize">register</h1>
  <p class="text-white/60 text-sm mt-2">Svelte page register � parity stub (data from +page.ts).</p>
  {#if data}
    <pre class="mt-4 text-xs bg-white/5 p-3 rounded overflow-auto">{JSON.stringify(data, null, 2).slice(0,800)}</pre>
  {/if}
  <a href="/" class="inline-block mt-4 text-sm text-white/60 hover:text-white">← Home</a>
</div>
