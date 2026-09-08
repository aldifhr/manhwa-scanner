<script lang="ts">
  import "../app.css";
  import Toaster from "$components/ui/Toaster.svelte";
  let { children, data }: any = $props();
  let isAuthed = $derived(!!data?.isAuthed);
  let menuOpen = $state(false);
  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" });
    location.href = "/";
  }
  function toggleMenu() {
    menuOpen = !menuOpen;
  }
  function closeMenu() {
    menuOpen = false;
  }
</script>

<svelte:head>
  <title>ManhwaScan — Read Manhwa & Manga Free</title>
  <meta name="description" content="Read manhwa, manga, and webtoon for free. Daily updates, best quality." />
  <link rel="manifest" href="/manifest.json" />
  <meta name="theme-color" content="#000000" />
</svelte:head>

<div class="min-h-dvh bg-[#09090b] text-white">
  <nav class="sticky top-0 z-40 flex items-center justify-between px-4 h-14 border-b border-white/[0.08] bg-[#09090b]">
    <a href="/" class="font-bold tracking-tight text-lg inline-flex items-center">ManhwaScan</a>
    <!-- Desktop nav -->
    <div class="hidden md:flex items-center gap-4 text-sm text-white/60 *:min-h-0 *:min-w-0">
      <a href="/" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">Home</a>
      <a href="/recent" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">Recent</a>
      <a href="/whitelist" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">Whitelist</a>
      <a href="/exclude-list" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">Exclude</a>
      <a href="/dispatch-history" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">History</a>
      <a href="/bookmarks" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">Bookmarks</a>
      {#if isAuthed}
        <button onclick={logout} class="min-h-0 min-w-0 inline-flex items-center justify-center text-xs px-3 h-7 rounded-full bg-white/[0.06] border border-white/[0.08] hover:bg-white/10 transition-colors">Logout</button>
      {:else}
        <a href="/login" class="inline-flex items-center h-7 px-1 hover:text-white transition-colors">Login</a>
      {/if}
    </div>
    <!-- Mobile hamburger -->
    <button onclick={toggleMenu} class="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg hover:bg-white/10 transition-colors" aria-label="Toggle menu">
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {#if menuOpen}
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        {:else}
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        {/if}
      </svg>
    </button>
  </nav>
  <!-- Mobile menu overlay -->
  {#if menuOpen}
    <div class="fixed inset-0 z-50 md:hidden" transition:fade>
      <div class="absolute inset-0 bg-black/60" onclick={closeMenu}></div>
      <div class="absolute right-0 top-14 bottom-0 w-64 bg-[#09090b] border-l border-white/[0.08] p-4 flex flex-col gap-2 animate-slide-in">
        <a href="/" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">Home</a>
        <a href="/recent" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">Recent</a>
        <a href="/whitelist" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">Whitelist</a>
        <a href="/exclude-list" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">Exclude</a>
        <a href="/dispatch-history" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">History</a>
        <a href="/bookmarks" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">Bookmarks</a>
        <div class="border-t border-white/[0.08] my-2"></div>
        {#if isAuthed}
          <button onclick={()=>{closeMenu(); logout();}} class="flex items-center justify-center px-3 py-2.5 rounded-lg bg-white/[0.06] border border-white/[0.08] hover:bg-white/10 text-sm">Logout</button>
        {:else}
          <a href="/login" onclick={closeMenu} class="flex items-center px-3 py-2.5 rounded-lg hover:bg-white/10 text-sm">Login</a>
        {/if}
      </div>
    </div>
  {/if}
  <main class="min-h-dvh pb-safe">
    {@render children()}
  </main>
  <Toaster />
</div>

<style>
  @keyframes slide-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
  .animate-slide-in {
    animation: slide-in 0.2s ease-out;
  }
  @keyframes fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  [transition\:fade] {
    animation: fade 0.15s ease-out;
  }
</style>
