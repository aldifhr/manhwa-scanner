<script lang="ts">
  import "../app.css";
  let { children } = $props();
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
    <div class="flex gap-4 text-sm text-white/70">
      <a href="/">Home</a>
      <a href="/recent">Recent</a>
      <a href="/whitelist">Whitelist</a>
      <a href="/bookmarks">Bookmarks</a>
      <a href="/login">Login</a>
    </div>
  </nav>
  <main class="min-h-dvh pb-safe">
    {@render children()}
  </main>
</div>
