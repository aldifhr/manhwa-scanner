<script lang="ts">
  import { cn } from "$lib/utils";
  let { class: className = "", children, ...rest }: any = $props();
</script>
<div class={cn("rounded-xl border border-white/10 bg-white/5", className)} {...rest}>
  {@render children?.()}
</div>
