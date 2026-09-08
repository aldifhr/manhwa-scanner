import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/logout");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/logout");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/logout");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/logout");

