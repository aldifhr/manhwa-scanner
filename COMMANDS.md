# Discord Bot Commands Summary

## 📚 Whitelist Management (7 commands)

| Command | Options | Function | Access |
|---------|---------|----------|--------|
| `/add` | `title:<judul>` `url:<url>` | Tambah manga ke whitelist | Semua user |
| `/remove` | `query:<judul/nomor/all>` | Hapus manga dari whitelist | Admin only |
| `/list` | `[page:<n>]` `[search:<keyword>]` `[filter:<status>]` | Lihat daftar manga whitelist | Semua user |
| `/search` | `query:<keyword>` `[page:<n>]` | Cari manga di whitelist (alias /list) | Semua user |
| `/mark` | `query:<judul>` `reason:<status>` | Tandai manga dengan status | Admin only |
| `/follow list` | - | Lihat manga yang di-follow | Semua user |
| `/follow unfollow` | `title:<judul>` | Berhenti follow manga | Semua user |

### Status Choices untuk /mark:
- `hiatus` - Tandai sebagai hiatus
- `end_season` - Tandai sebagai end season
- `end` - Tandai sebagai tamat
- `clear` - Hapus penanda

---

## 🔔 Notification & Follow (3 commands)

| Command | Options | Function | Access |
|---------|---------|----------|--------|
| `/pref` | `[mode:<all/follows/none>]` | Atur mode notifikasi | Semua user |
| `/setchannel` | `channel:<#channel>` | Set channel notifikasi chapter baru | Admin only |

### Mode Choices untuk /pref:
- `all` - Dapat notif semua manga
- `follows` - Hanya manga yang di-follow
- `none` - Tidak ada notifikasi

---

## 📖 User Progress (2 commands)

| Command | Options | Function | Access |
|---------|---------|----------|--------|
| `/myprogress list` | `[page:<n>]` | Lihat progress baca manga | Semua user |
| `/myprogress clear` | `judul:<manga>` | Hapus manga dari progress | Semua user |

---

## ⚙️ Admin & System (5 commands)

| Command | Options | Function | Access |
|---------|---------|----------|--------|
| `/sync` | `mode:<quick/deep>` `[broadcast:<true/false>]` `[dry_run:<true/false>]` `[max_send:<n>]` | Sinkronisasi manual whitelist | Admin only |
| `/status report` | - | Lihat laporan status bot lengkap | Admin only |
| `/status perm_add` | `user_id:<id>` | Grant akses /add ke user | Owner only |
| `/status perm_remove` | `user_id:<id>` | Revoke akses /add dari user | Owner only |
| `/status perm_list` | - | Lihat user dengan akses /add | Admin only |
| `/permission` | `user:<@user>` `action:<grant/revoke>` | Kelola permission admin (alternatif) | Owner only |
| `/health` | - | Cek kesehatan sistem bot | Admin only |
| `/clear` | - | Hapus SELURUH whitelist (DANGER!) | Owner only |

### Mode Sync:
- `quick` - Cek chapter baru saja (cepat)
- `deep` - Resync metadata lengkap (lambat)

---

## 📊 Summary

- **Total Commands**: 14
- **User Commands**: 7 (`/add`, `/list`, `/search`, `/follow`, `/myprogress`, `/pref`)
- **Admin Commands**: 6 (`/remove`, `/mark`, `/setchannel`, `/sync`, `/status`, `/health`)
- **Owner Commands**: 2 (`/permission`, `/clear`)

---

## 📝 Contoh Penggunaan

```bash
# User Commands
/add title:Solo Leveling
/list page:1 search:Solo
/follow list
/myprogress list page:1
/pref mode:follows

# Admin Commands
/remove query:1
/mark query:Solo Leveling reason:hiatus
/setchannel channel:#manga-updates
/sync mode:quick broadcast:true
/status report

# Owner Commands
/permission user:@username action:grant
/clear
```
