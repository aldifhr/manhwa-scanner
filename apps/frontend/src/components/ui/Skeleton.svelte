<script lang="ts">
  import { cn } from "$lib/utils";
  let { class: className = "", ...rest }: any = $props();
</script>
<div class={cn("skeleton rounded", className)} {...rest}></div>
