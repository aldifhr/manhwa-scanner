import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/refresh-voratoon");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/refresh-voratoon");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/refresh-voratoon");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/health/refresh-voratoon");

