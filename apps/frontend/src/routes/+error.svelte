<script lang="ts">
  import { page } from "$app/stores";
</script>

<div class="flex flex-col items-center justify-center min-h-[50vh] gap-4 p-8 text-center">
  <h1 class="text-2xl font-bold">{$page.status} — {$page.error?.message ?? "Something went wrong"}</h1>
  <a href="/" class="px-4 py-2 rounded bg-white text-black text-sm font-medium">Back to Home</a>
</div>
