import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/detailed");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/detailed");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/detailed");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/detailed");

