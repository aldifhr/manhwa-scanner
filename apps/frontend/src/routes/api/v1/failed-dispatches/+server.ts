import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/failed-dispatches");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/failed-dispatches");
