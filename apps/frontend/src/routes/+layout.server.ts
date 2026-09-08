import type { LayoutServerLoad } from "./$types";
import { COOKIE_NAME, verifyToken } from "$lib/auth";
export const load: LayoutServerLoad = async ({ cookies }) => {
  const token = cookies.get(COOKIE_NAME);
  const isAuthed = !!token && verifyToken(token);
  return { isAuthed };
};
