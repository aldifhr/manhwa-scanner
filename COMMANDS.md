# COMMANDS.md

Dokumen ini mengikuti definisi command di `scripts/sync-commands.js`.

## Daftar Command

| Command | Opsi | Keterangan |
|---|---|---|
| `/status` | - | Lihat status whitelist saat ini |
| `/add` | `query` (required) | Tambah manga ke whitelist (judul atau URL) |
| `/remove` | `query` (required) | Hapus manga dari whitelist (judul/URL/nomor urut) |
| `/mark` | `item` (required), `reason` (required) | Tandai status manga |
| `/setchannel` | `channel` (required) | Set channel notifikasi |
| `/clear` | - | Hapus semua whitelist (owner only) |
| `/health` | - | Cek kesehatan sumber/scraper |
| `/permission` | `action` (required), `user` (optional) | Kelola izin `/add` |
| `/follow list` | `page` (optional) | Lihat daftar manga yang di-follow |
| `/follow unfollow` | `title` (required) | Berhenti follow manga tertentu |
| `/sync` | - | Trigger sinkronisasi manual (admin only) |

## Choice Values

### `/mark reason`
- `hiatus`
- `end_season`
- `end`
- `clear`

### `/permission action`
- `add`
- `remove`
- `list`

## Contoh

```text
/add query:Solo Leveling
/remove query:1
/mark item:Solo Leveling reason:hiatus
/follow list page:2
/follow unfollow title:Solo Leveling
/permission action:list
```

## Sinkronisasi ke Discord

Setelah ubah definisi command, jalankan:

```bash
node scripts/sync-commands.js
```
