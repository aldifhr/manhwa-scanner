<script lang="ts">
  import { cn } from "$lib/utils";
  let { variant = "default", size = "default", class: className = "", children, ...rest }: any = $props();
  const base = "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:opacity-50";
  const variants: Record<string,string> = {
    default: "bg-white text-black hover:bg-zinc-200",
    ghost: "bg-transparent hover:bg-white/10",
    outline: "border border-white/10 hover:bg-white/10"
  };
  const sizes: Record<string,string> = { default: "px-4 py-2 text-sm", sm: "px-3 py-1 text-xs", lg: "px-6 py-3" };
</script>
<button class={cn(base, variants[variant] ?? variants.default, sizes[size] ?? sizes.default, className)} {...rest}>
  {@render children?.()}
</button>
