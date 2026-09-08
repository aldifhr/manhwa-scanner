import type { RequestHandler } from "./$types";
import { proxyToScanner } from "$lib/proxy";
export const GET: RequestHandler = async (event) => proxyToScanner(event, "/api/debug/login-direct");
export const POST: RequestHandler = async (event) => proxyToScanner(event, "/api/debug/login-direct");
export const DELETE: RequestHandler = async (event) => proxyToScanner(event, "/api/debug/login-direct");
export const PUT: RequestHandler = async (event) => proxyToScanner(event, "/api/debug/login-direct");

