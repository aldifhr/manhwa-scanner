import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/public/stats");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/public/stats");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/public/stats");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/public/stats");

