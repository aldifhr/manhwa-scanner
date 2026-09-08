<script lang="ts">
  import { cn } from "$lib/utils";
  let { class: className = "", children, ...rest }: any = $props();
</script>
<span class={cn("inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-white/[0.06] border border-white/[0.08] text-white/70", className)} {...rest}>
  {@render children?.()}
</span>
