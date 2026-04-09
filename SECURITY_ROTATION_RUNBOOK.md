# Secret Rotation Runbook

Tanggal: 2026-04-09
Repo: `d:\ikiru-bot`

## Scope

Runbook ini untuk menutup sisa risiko secret eksternal yang tidak bisa dirotasi otomatis dari kode:
- Discord Bot Token (`DISCORD_BOT_TOKEN`)
- Discord Webhook URL (`DISCORD_WEBHOOK_URL`)
- Upstash REST Token (`UPSTASH_REDIS_REST_TOKEN`)

## Prasyarat

- Akses owner/admin ke Discord Developer Portal untuk aplikasi bot.
- Akses admin ke channel Discord yang menyimpan webhook.
- Akses owner/admin ke dashboard Upstash Redis.
- Akses update environment variables di platform deployment (Vercel/project env).

## 1) Rotasi Discord Bot Token

1. Buka Discord Developer Portal.
2. Pilih aplikasi bot yang dipakai proyek ini.
3. Masuk ke menu `Bot`.
4. Klik `Reset Token` / `Regenerate`.
5. Simpan token baru di password manager.
6. Update env `DISCORD_BOT_TOKEN` di environment deployment.
7. Jika `.env` lokal dipakai untuk dev, update juga nilainya.

Verifikasi cepat:
- Jalankan `node scripts/sync-commands.js`.
- Pastikan command sync sukses (tidak 401/unauthorized).

## 2) Rotasi Discord Webhook URL

1. Buka Discord channel yang dipakai webhook.
2. Edit Integrations -> Webhooks.
3. Hapus webhook lama atau regenerate URL.
4. Buat/salin URL webhook baru.
5. Update env `DISCORD_WEBHOOK_URL` di deployment + lokal (jika perlu).

Verifikasi cepat:
- Trigger satu event/error log yang mengirim webhook.
- Pastikan pesan muncul di channel target.

## 3) Rotasi Upstash REST Token

1. Buka Upstash Console.
2. Pilih database Redis yang dipakai bot.
3. Rotasi/create token REST baru.
4. Update env `UPSTASH_REDIS_REST_TOKEN` (dan `UPSTASH_REDIS_REST_URL` bila berubah).
5. Simpan token baru di secret manager.

Verifikasi cepat:
- Jalankan endpoint yang membutuhkan Redis (mis. `/api/history`).
- Pastikan tidak ada error auth Redis.

## 4) Deploy & Validasi Pasca Rotasi

1. Redeploy aplikasi setelah semua env diupdate.
2. Jalankan smoke test:
   - Auth dashboard login
   - `/api/history?action=recent`
   - `/api/history?action=logs`
   - Trigger command Discord (`/status`, `/follow list`)
3. Monitor log 10-15 menit untuk memastikan tidak ada 401/403 dari Discord/Redis.

## 5) Post-rotation Hygiene

- Pastikan secret lama dinonaktifkan/dihapus permanen.
- Jangan kirim secret lewat chat/issue tracker.
- Simpan audit trail rotasi (siapa, kapan, apa yang dirotasi).

## Checklist Penutupan

- [ ] `DISCORD_BOT_TOKEN` baru aktif
- [ ] `DISCORD_WEBHOOK_URL` baru aktif
- [ ] `UPSTASH_REDIS_REST_TOKEN` baru aktif
- [ ] Redeploy selesai
- [ ] Smoke test lulus
- [ ] Secret lama dinonaktifkan
