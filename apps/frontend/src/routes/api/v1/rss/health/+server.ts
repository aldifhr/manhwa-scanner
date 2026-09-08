import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/rss/health");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/rss/health");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/rss/health");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/rss/health");

