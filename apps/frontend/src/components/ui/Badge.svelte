<script lang="ts">
  import { cn } from "$lib/utils";
  let { class: className = "", children, ...rest }: any = $props();
</script>
<span class={cn("inline-flex items-center px-2 py-1 rounded text-xs bg-white/10", className)} {...rest}>
  {@render children?.()}
</span>
