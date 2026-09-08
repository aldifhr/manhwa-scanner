import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = (e) => proxyToScanner(e, "/api/v1/reader/rss");
