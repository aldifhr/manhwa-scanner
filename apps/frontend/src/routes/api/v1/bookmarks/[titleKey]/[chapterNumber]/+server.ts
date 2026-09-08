import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/bookmarks/"+event.params.titleKey+"/"+event.params.chapterNumber);
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/bookmarks/"+event.params.titleKey+"/"+event.params.chapterNumber);
