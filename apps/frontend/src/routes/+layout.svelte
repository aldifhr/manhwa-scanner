<script lang="ts">
  import "../app.css";
  import Toaster from "$components/ui/Toaster.svelte";
  let { children, data }: any = $props();
  let isAuthed = $derived(!!data?.isAuthed);
  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    location.href = "/";
  }
</script>

<svelte:head>
  <title>ManhwaScan — Read Manhwa & Manga Free</title>
  <meta name="description" content="Read manhwa, manga, and webtoon for free. Daily updates, best quality." />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#000000" />
</svelte:head>

<div class="min-h-dvh bg-black text-white">
  <nav class="sticky top-0 z-40 flex items-center justify-between px-4 h-14 border-b border-white/10 bg-black/80 backdrop-blur">
    <a href="/" class="font-bold tracking-tighter text-lg inline-flex items-center">ManhwaScan</a>
    <div class="flex items-center gap-4 text-sm text-white/70 *:min-h-0 *:min-w-0">
      <a href="/" class="inline-flex items-center h-7 px-1">Home</a>
      <a href="/recent" class="inline-flex items-center h-7 px-1">Recent</a>
      <a href="/whitelist" class="inline-flex items-center h-7 px-1">Whitelist</a>
      <a href="/bookmarks" class="inline-flex items-center h-7 px-1">Bookmarks</a>
      {#if isAuthed}
        <button onclick={logout} class="min-h-0 min-w-0 inline-flex items-center justify-center text-xs px-3 h-7 rounded-full bg-white/10 hover:bg-white/20">Logout</button>
      {:else}
        <a href="/login" class="inline-flex items-center h-7 px-1">Login</a>
      {/if}
    </div>
  </nav>
  <main class="min-h-dvh pb-safe">
    {@render children()}
  </main>
  <Toaster />
</div>
