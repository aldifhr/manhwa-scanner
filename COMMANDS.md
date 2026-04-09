# COMMANDS.md

Dokumen ini mengikuti definisi command di `scripts/sync-commands.js`.

## Daftar Command

| Command | Opsi | Keterangan |
|---|---|---|
| `/status` | - | Lihat status whitelist saat ini |
| `/add` | `query` (required) | Tambah manga ke whitelist (judul atau URL) |
| `/remove` | `query` (required) | Hapus manga dari whitelist (judul/URL/nomor urut) |
| `/setchannel` | `channel` (required) | Set channel notifikasi |
| `/follow list` | `page` (optional) | Lihat daftar manga yang di-follow |
| `/follow unfollow` | `title` (required) | Berhenti follow manga tertentu |

## Contoh

```text
/add query:Solo Leveling
/remove query:1
/follow list page:2
/follow unfollow title:Solo Leveling
```

## Sinkronisasi ke Discord

Setelah ubah definisi command, jalankan:

```bash
node scripts/sync-commands.js
```
