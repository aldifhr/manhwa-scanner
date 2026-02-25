import { Redis } from "@upstash/redis";

const AUTH_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function loadWhitelist() {
  try {
    const data = await redis.get("whitelist:manga");
    if (!data) return [];
    // Handle both array and string formats
    if (Array.isArray(data)) return data;
    if (typeof data === "string") return JSON.parse(data);
    return [];
  } catch (err) {
    console.error("Load whitelist error:", err.message);
    return [];
  }
}

async function saveWhitelist(manga) {
  await redis.set("whitelist:manga", manga);
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ikiru Bot - Whitelist Manager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header p { opacity: 0.9; }
    .content { padding: 30px; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 12px;
      text-align: center;
    }
    .stat-card .number {
      font-size: 32px;
      font-weight: bold;
      color: #667eea;
    }
    .stat-card .label {
      color: #666;
      font-size: 14px;
      margin-top: 5px;
    }
    .form-section {
      background: #f8f9fa;
      padding: 25px;
      border-radius: 12px;
      margin-bottom: 25px;
    }
    .form-section h2 {
      margin-bottom: 20px;
      color: #333;
    }
    .input-group {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
    }
    input[type="text"], input[type="password"] {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.3s;
    }
    input[type="text"]:focus, input[type="password"]:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }
    .btn-danger {
      background: #ff4757;
      color: white;
      padding: 8px 16px;
      font-size: 14px;
    }
    .btn-danger:hover {
      background: #ff3838;
    }
    .manga-list {
      max-height: 400px;
      overflow-y: auto;
    }
    .manga-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px;
      background: white;
      border-radius: 8px;
      margin-bottom: 10px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.05);
    }
    .manga-item:hover {
      box-shadow: 0 4px 10px rgba(0,0,0,0.1);
    }
    .manga-title {
      font-weight: 500;
      color: #333;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #999;
    }
    .message {
      padding: 12px 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .message.success {
      background: #d4edda;
      color: #155724;
    }
    .message.error {
      background: #f8d7da;
      color: #721c24;
    }
    .login-form {
      max-width: 400px;
      margin: 100px auto;
      background: white;
      padding: 40px;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .login-form h2 {
      text-align: center;
      margin-bottom: 30px;
      color: #333;
    }
  </style>
</head>
<body>
  {{CONTENT}}
</body>
</html>`;

function renderLogin(message = null) {
  const content = `
    <div class="login-form">
      <h2>🔐 Admin Login</h2>
      ${message ? `<div class="message error">${message.error}</div>` : ''}
      <form method="POST" action="/api/admin">
        <div class="input-group">
          <input type="password" name="password" placeholder="Enter password" required>
        </div>
        <button type="submit" class="btn-primary" style="width: 100%;">Login</button>
      </form>
    </div>
  `;
  return HTML_TEMPLATE.replace("{{CONTENT}}", content);
}

function renderDashboard(whitelist, message = "") {
  const mangaList = whitelist.length > 0 
    ? whitelist.map((m, i) => `
        <div class="manga-item">
          <span class="manga-title">${i + 1}. ${m}</span>
          <form method="POST" action="/api/admin" style="display: inline;">
            <input type="hidden" name="action" value="remove">
            <input type="hidden" name="title" value="${m}">
            <button type="submit" class="btn-danger">Remove</button>
          </form>
        </div>
      `).join('')
    : '<div class="empty-state">No manga in whitelist</div>';

  const content = `
    <div class="container">
      <div class="header">
        <h1>📚 Ikiru Bot Manager</h1>
        <p>Manage your manga whitelist</p>
      </div>
      <div class="content">
        ${message ? `<div class="message ${message.type}">${message.text}</div>` : ''}
        
        <div class="stats">
          <div class="stat-card">
            <div class="number">${whitelist.length}</div>
            <div class="label">Whitelisted</div>
          </div>
        </div>

        <div class="form-section">
          <h2>➕ Add Manga</h2>
          <form method="POST" action="/api/admin">
            <input type="hidden" name="action" value="add">
            <div class="input-group">
              <input type="text" name="title" placeholder="Enter manga title" required>
              <button type="submit" class="btn-primary">Add</button>
            </div>
          </form>
        </div>

        <div class="form-section">
          <h2>📋 Whitelist (${whitelist.length})</h2>
          <div class="manga-list">
            ${mangaList}
          </div>
        </div>
      </div>
    </div>
  `;
  return HTML_TEMPLATE.replace("{{CONTENT}}", content);
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  // Simple session using cookie
  const cookies = req.headers.cookie || "";
  const isAuthenticated = cookies.includes("admin=1");

  if (req.method === "GET") {
    if (!isAuthenticated) {
      return res.status(200).setHeader("Content-Type", "text/html").send(renderLogin());
    }
    const whitelist = await loadWhitelist();
    return res.status(200).setHeader("Content-Type", "text/html").send(renderDashboard(whitelist));
  }

  if (req.method === "POST") {
    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", chunk => data += chunk);
      req.on("end", () => {
        const params = new URLSearchParams(data);
        const result = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        resolve(result);
      });
    });

    // Login
    if (body.password) {
      if (body.password === AUTH_PASSWORD) {
        res.setHeader("Set-Cookie", "admin=1; Path=/; Max-Age=86400; SameSite=Lax");
        const whitelist = await loadWhitelist();
        return res.status(200).setHeader("Content-Type", "text/html").send(renderDashboard(whitelist, { type: "success", text: "✅ Login successful!" }));
      } else {
        return res.status(200).setHeader("Content-Type", "text/html").send(renderLogin({ error: "❌ Wrong password!" }));
      }
    }

    // Check auth for actions
    if (!isAuthenticated) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const whitelist = await loadWhitelist();
    let message = null;

    if (body.action === "add" && body.title) {
      const title = body.title.trim();
      if (!whitelist.some(w => w.toLowerCase() === title.toLowerCase())) {
        whitelist.push(title);
        await saveWhitelist(whitelist);
        message = { type: "success", text: `✅ Added "${title}"` };
      } else {
        message = { type: "error", text: `⚠️ "${title}" already exists` };
      }
    }

    if (body.action === "remove" && body.title) {
      const index = whitelist.findIndex(w => w === body.title);
      if (index > -1) {
        whitelist.splice(index, 1);
        await saveWhitelist(whitelist);
        message = { type: "success", text: `✅ Removed "${body.title}"` };
      }
    }

    return res.status(200).setHeader("Content-Type", "text/html").send(renderDashboard(whitelist, message));
  }

  return res.status(405).json({ error: "Method not allowed" });
}
