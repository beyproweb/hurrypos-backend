## Standalone: QR Menu + Kitchen

### Register
```bash
curl -X POST http://localhost:5000/api/standalone/auth/register \
  -H "Content-Type: application/json" \
  -d '{"full_name":"Ada Lovelace","email":"ada@example.com","password":"Secret123!","business_name":"Ada Cafe"}'
```

### Login
```bash
curl -X POST http://localhost:5000/api/standalone/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"Secret123!"}'
```

### Quick test
1) Register or login to get `token`.
2) Open `http://localhost:5173/standalone/app`.
3) Confirm access to **QR Menü Ayarları** and **Mutfak**.
4) Try a POS-only endpoint (e.g. `GET /api/products`) and expect `403 MODULE_NOT_ALLOWED`.
