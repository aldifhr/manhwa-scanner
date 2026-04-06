import axios from "axios";

const LOGIN_URL = `${(process.env.IKIRU_BASE_URL || "https://02.ikiru.wtf").replace(/\/+$/, "")}/wp-login.php`;

/**
 * Login ke ikiru dan return cookie string segar.
 * Set IKIRU_EMAIL dan IKIRU_PASSWORD di .env untuk mengaktifkan realtime mode.
 */
export async function refreshCookie() {
  const email    = process.env.IKIRU_EMAIL;
  const password = process.env.IKIRU_PASSWORD;

  if (!email || !password) {
    console.warn("[cookie] IKIRU_EMAIL/PASSWORD tidak diset, skip cookie refresh");
    return null;
  }

  try {
    const params = new URLSearchParams({
      log:        email,
      pwd:        password,
      wp_submit:  "Log In",
      redirect_to: "/wp-admin/",
      testcookie: "1",
    });

    const res = await axios.post(LOGIN_URL, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cookie":       "wordpress_test_cookie=WP%20Cookie%20check",
      },
      maxRedirects:   0,
      validateStatus: (s) => s === 302 || s === 200,
    });

    // Login gagal kalau WordPress redirect balik ke login page
    const location = res.headers["location"] ?? "";
    if (res.status === 302 && location.includes("login=failed")) {
      console.error("[cookie] Login gagal — kredensial salah");
      return null;
    }

    const rawCookies = res.headers["set-cookie"];
    if (!rawCookies?.length) {
      console.error("[cookie] Login gagal — tidak ada cookie di response");
      return null;
    }

    // Pastikan ada auth cookie — tanda login benar-benar sukses
    const hasAuthCookie = rawCookies.some((c) =>
      c.startsWith("wordpress_logged_in_"),
    );
    if (!hasAuthCookie) {
      console.error("[cookie] Login gagal — tidak ada wordpress_logged_in cookie");
      return null;
    }

    // Ambil key=value saja, buang expires/path/domain/dll
    const cookieString = rawCookies
      .map((c) => c.split(";")[0])
      .join("; ");

    console.log("[cookie] Cookie berhasil diperbarui");
    return cookieString;
  } catch (err) {
    console.error("[cookie] Gagal refresh cookie:", err.message);
    return null;
  }
}
