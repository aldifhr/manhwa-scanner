// ponytail: shim deleted (was 150L re-export of Reader). Import Reader for rss/whitelist/exclude.

  if (typeof document === "undefined") return true;
  // ponytail: session is httpOnly → check readable csrf twin
  return !document.cookie.match(/(?:^|;\s*)ikiru_csrf_token=/);
}
  try {
    if (!raw) return [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
  try {
  } catch {}
}

  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source: string;
  position_pct: number;
  updated_at: string;
  title?: string;
  cover?: string | null;
}
  page = 1,
  pageSize = 50
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const start = (page - 1) * pageSize;
    return all.slice(start, start + pageSize);
  }
  try {
    const { readerFetch } = await import("$lib/reader/transport");
    const qs =
      page !== 1 || pageSize !== 50
        ? `?page=${page}&page_size=${pageSize}`
        : "";
    const body = await readerFetch<{
      success: boolean;
    const d = body.data as unknown;
    if (
      d &&
      typeof d === "object" &&
      "results" in (d as Record<string, unknown>)
    )
      return (
      );
    return [];
  } catch (e) {
    if (
      (e as Error)?.message?.includes("404") ||
      (e as Error)?.message?.includes("401") ||
      (e as Error)?.message?.includes("403")
    )
      return [];
    throw e;
  }
}
  page = 1,
  pageSize = 50
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const start = (page - 1) * pageSize;
    const slice = all.slice(start, start + pageSize);
    return {
      results: slice,
      total: all.length,
      hasMore: start + pageSize < all.length,
    };
  }
  const { readerFetch } = await import("$lib/reader/transport");
  const body = await readerFetch<{
    success: boolean;
  const d = body.data as unknown;
  if (Array.isArray(d))
    return {
      hasMore: false,
    };
  return (
      results: [],
      total: 0,
      hasMore: false,
    }
  );
}
  title_key: string;
  chapter_number: number;
  chapter_url: string;
  source?: string;
  position_pct?: number;
  title?: string;
  cover?: string | null;
}): Promise<void> {
    const idx = all.findIndex(
      (b) =>
        b.title_key === data.title_key &&
        b.chapter_number === data.chapter_number
    );
      ...data,
      position_pct: data.position_pct ?? 0,
      updated_at: new Date().toISOString(),
      source: data.source ?? "",
      title: data.title ?? data.title_key,
      cover: data.cover ?? null,
    };
    if (idx >= 0) all[idx] = entry;
    else all.unshift(entry);
    return;
  }
  const { readerFetch } = await import("$lib/reader/transport");
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
  titleKey: string,
  chapterNumber: number
): Promise<void> {
      (b) => !(b.title_key === titleKey && b.chapter_number === chapterNumber)
    );
    return;
  }
  const { readerFetch } = await import("$lib/reader/transport");
    method: "DELETE",
  });
}


