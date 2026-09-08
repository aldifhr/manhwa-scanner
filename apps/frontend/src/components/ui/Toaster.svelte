<script lang="ts">
  import { toasts } from "$lib/toast.svelte";
</script>
<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
  {#each $toasts as t (t.id)}
    <div class="pointer-events-auto px-4 py-2 rounded-lg text-sm shadow-lg border backdrop-blur
      {t.type==="success" ? "bg-green-500/15 border-green-500/20 text-green-200" : ""}
      {t.type==="error" ? "bg-red-500/15 border-red-500/20 text-red-200" : ""}
      {t.type==="info" ? "bg-white/10 border-white/10 text-white" : ""}">
      {t.message}
    </div>
  {/each}
</div>
