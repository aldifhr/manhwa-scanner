<script lang="ts">
  import "../app.css";
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
  <nav class="sticky top-0 z-40 flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/80 backdrop-blur">
    <a href="/" class="font-bold tracking-tighter text-lg">ManhwaScan</a>
    <div class="flex gap-4 text-sm text-white/70 items-center *:min-h-0 *:min-w-0">
      <a href="/" class="leading-none py-1">Home</a>
      <a href="/recent" class="leading-none py-1">Recent</a>
      <a href="/whitelist" class="leading-none py-1">Whitelist</a>
      <a href="/bookmarks" class="leading-none py-1">Bookmarks</a>
      {#if isAuthed}
        <button onclick={logout} class="min-h-0 min-w-0 text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 leading-none">Logout</button>
      {:else}
        <a href="/login" class="leading-none py-1">Login</a>
      {/if}
    </div>
  </nav>
  <main class="min-h-dvh pb-safe">
    {@render children()}
  </main>
</div>
