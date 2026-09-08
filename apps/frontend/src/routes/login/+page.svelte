<script lang="ts">
  import { page } from "$app/stores";
  let password = $state("");
  let error = $state("");
  let loading = $state(false);
  let show = $state(false);
  function sanitize(raw: string | null): string {
    if (!raw) return "/";
    if (/[\x00-\x1f\\]/.test(raw)) return "/";
    if (/^(https?:)?\/\//i.test(raw)) return "/";
    if (/^(javascript|data|vbscript):/i.test(raw)) return "/";
    if (!raw.startsWith("/")) return "/";
    return raw;
  }
  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    error = ""; loading = true;
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = (data as any).error;
        error = (err && typeof err === "object" ? err.message : err) || "Login failed";
        return;
      }
      const redirect = sanitize(new URLSearchParams($page.url.search).get("redirect"));
      window.location.href = redirect;
    } catch {
      error = "Network error";
    } finally { loading = false; }
  }
</script>

<div class="relative min-h-[calc(100dvh-56px)] flex items-center justify-center px-4 py-8">
  <div class="w-full max-w-sm mx-auto">
    <div class="flex flex-col items-center mb-6">
      <h1 class="text-2xl font-bold tracking-tight">Manhwa<span class="text-[var(--gold-accent)]">Scanner</span></h1>
      <p class="text-white/50 text-sm mt-1 tracking-wide uppercase">dashboard</p>
    </div>
    <form onsubmit={handleSubmit} class="bg-[var(--gold-surface)] border border-[var(--gold-border)] rounded-xl p-6 space-y-5">
      {#if error}<div class="rounded-lg px-3 py-2 text-sm bg-red-500/10 border border-red-500/20 text-red-400">{error}</div>{/if}
      <div>
        <label for="password" class="block text-[13px] font-medium text-white/70 mb-2">Password</label>
        <div class="relative">
          <input id="password" type={show ? "text" : "password"} bind:value={password} placeholder="Password" autocomplete="current-password" required class="w-full bg-black border border-white/10 rounded-lg px-3.5 py-2.5 pr-10 text-sm placeholder:text-white/30 focus:outline-none focus:border-[var(--gold-accent)]" />
          <button type="button" onclick={() => show = !show} class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white text-xs">{show ? "Hide" : "Show"}</button>
        </div>
      </div>
      <button type="submit" disabled={loading || !password} class="w-full bg-[var(--gold-accent)] hover:bg-[var(--gold-accent-hover)] text-black text-sm font-medium rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 disabled:opacity-40">
        {#if loading}<span class="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>{:else}Sign in →{/if}
      </button>
    </form>
    <p class="text-center w-full text-white/30 text-xs mt-4 tracking-widest uppercase">secured access only</p>
  </div>
</div>
