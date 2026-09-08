import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/login");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/login");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/login");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/v1/auth/login");

