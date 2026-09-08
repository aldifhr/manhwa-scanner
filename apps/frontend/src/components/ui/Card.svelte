<script lang="ts">
  import { cn } from "$lib/utils";
  let { class: className = "", children, ...rest }: any = $props();
</script>
<div class={cn("rounded-xl border border-white/[0.08] bg-[#18181b]", className)} {...rest}>
  {@render children?.()}
</div>
