import axios from "axios";

const SITE_URL = "https://02.ikiru.wtf/";
const LOGIN_URL = "https://02.ikiru.wtf/wp-login.php";

/**
 * Login ke ikiru dan return cookie string segar
 * Simpan IKIRU_USERNAME dan IKIRU_PASSWORD di .env
 */
export async function refreshCookie() {
  const username = process.env.IKIRU_EMAIL;
  const password = process.env.IKIRU_PASSWORD;

  if (!username || !password) {
    console.log("⚠️  IKIRU_EMAIL/PASSWORD tidak diset, skip cookie refresh");
    return null;
  }

  try {
    const params = new URLSearchParams({
      log: username,
      pwd: password,
      wp_submit: "Log In",
      redirect_to: "/wp-admin/",
      testcookie: "1",
    });

    const res = await axios.post(LOGIN_URL, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cookie": "wordpress_test_cookie=WP%20Cookie%20check", // required by WP login
      },
      maxRedirects: 0,
      validateStatus: (s) => s === 302 || s === 200,
    });

    // Ambil cookie dari response headers
    const rawCookies = res.headers["set-cookie"];
    if (!rawCookies?.length) {
      console.error("❌ Login gagal — tidak ada cookie di response");
      return null;
    }

    // Parse jadi satu string cookie
    const cookieString = rawCookies
      .map((c) => c.split(";")[0]) // ambil key=value saja, buang expires/path/dll
      .join("; ");

    console.log("🍪 Cookie berhasil diperbarui");
    return cookieString;
  } catch (err) {
    console.error("❌ Gagal refresh cookie:", err.message);
    return null;
  }
}