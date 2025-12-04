# Backend Deployment Guide - Beypro POS

**Document Version:** 1.0  
**Last Updated:** January 2025  
**Purpose:** Deploy printer detection enhancements to Render.com production

---

## 📋 Quick Summary

This guide deploys the enhanced printer detection code (`routes/printer.js`) to production. The key improvements include:
- **ESC/POS fingerprinting** via network TCP probing
- **Network printer auto-discovery** (`/discover-network` endpoint)
- **Enhanced LAN scanning** with device fingerprinting
- **Manufacturer/model extraction** from printer responses

**Status:** ✅ Code ready for deployment

---

## 🔧 Prerequisites

Before deploying, ensure:

1. **Git access to repository**
   ```bash
   cd /Users/nurikord/PycharmProjects/hurrypos-backend
   git status
   ```

2. **All local changes committed**
   ```bash
   git add -A
   git commit -m "Add: ESC/POS fingerprinting and network discovery"
   ```

3. **Main branch checked out**
   ```bash
   git checkout main
   ```

4. **Remote configured**
   ```bash
   git remote -v  # Should show GitHub URL
   ```

5. **Backend .env configured** (already done)
   ```bash
   cat .env | grep DATABASE_URL
   # Should show: dpg-d22jfm95pdvs7392if0g-a.frankfurt-postgres.render.com
   ```

---

## 📤 Deployment Steps

### **Option 1: Automated Render Deployment (Recommended)**

**How it works:** Push to GitHub → Render auto-deploys

**Steps:**

1. **Verify changes committed:**
   ```bash
   git status
   # Should show "nothing to commit"
   ```

2. **Push to GitHub:**
   ```bash
   git push origin main
   ```

3. **Monitor deployment:**
   - Go to https://dashboard.render.com
   - Select "hurrypos-backend" service
   - View "Deploys" tab
   - Wait for status: "Live" (2-5 minutes)

4. **Verify endpoints live:**
   ```bash
   # Test basic connectivity
   curl https://hurrypos-backend.onrender.com/api/printer-settings/status
   
   # Test LAN scan
   curl https://hurrypos-backend.onrender.com/api/printer-settings/lan-scan
   
   # Test network discovery
   curl https://hurrypos-backend.onrender.com/api/printer-settings/discover-network
   ```

### **Option 2: Manual Render Redeployment**

If auto-deployment doesn't trigger:

1. **Go to Render Dashboard:**
   - https://dashboard.render.com

2. **Select Service:**
   - Click "hurrypos-backend" service

3. **Manual Deploy:**
   - Click "Manual Deploy" button
   - Select branch: `main`
   - Click "Deploy"

4. **Wait for completion:**
   - Status changes from "Building" → "Deploying" → "Live"
   - Check logs for any errors

### **Option 3: Rollback (If Issues)**

**If deployment causes problems:**

1. **Identify last working commit:**
   ```bash
   git log --oneline | head -10
   ```

2. **Revert to previous version:**
   ```bash
   git revert HEAD  # Creates new commit undoing changes
   git push origin main
   ```

3. **Render redeploys automatically**

---

## ✅ Verification Checklist

After deployment, verify all endpoints:

### **1. Check Backend Status**
```bash
curl https://hurrypos-backend.onrender.com/api/printer-settings/status
# Expected: { "status": "ok" } or similar
```

### **2. Test LAN Scan**
```bash
curl -X POST \
  https://hurrypos-backend.onrender.com/api/printer-settings/lan-scan \
  -H "Content-Type: application/json" \
  -d '{"subnet": "192.168.1", "fingerprint": true}'
# Expected: Array of printers with ESC/POS confirmation
```

### **3. Test Network Discovery**
```bash
curl https://hurrypos-backend.onrender.com/api/printer-settings/discover-network
# Expected: Auto-discovered network printers
```

### **4. Test USB Printers Endpoint**
```bash
curl https://hurrypos-backend.onrender.com/api/printer-settings/printers
# Expected: { "usb": [...], "serial": [...], "tips": [...] }
```

### **5. Test in Frontend**
- Open Electron app (v17.0.0)
- Go to Settings → Printers tab
- Run "Scan Network"
- Should show network printers with 🟢 (ESC/POS confirmed)

---

## 📡 Environment Variables

All variables already configured in Render dashboard:

| Variable | Value | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection |
| `JWT_SECRET` | `beypro_secret_2025` | Authentication |
| `NODE_ENV` | `production` | Runtime environment |
| `API_PORT` | `3000` | Server port |

**No new variables needed for this deployment.**

---

## 🔍 Monitoring Deployment

### **Render Dashboard**
1. Go to https://dashboard.render.com
2. Select "hurrypos-backend"
3. View "Deploys" tab:
   - In Progress → Blue spinner
   - Live → Green checkmark
   - Failed → Red X
4. Click deploy for full logs

### **View Logs**
```
https://dashboard.render.com/services/...
→ Logs tab
→ Filter by recent activity
```

### **Common Issues**

| Issue | Solution |
|-------|----------|
| Deployment stuck | Manual restart in Render dashboard |
| 502 Bad Gateway | Wait 2-5 minutes for deployment |
| Port binding error | Check NODE_ENV is "production" |
| Database connection fails | Verify DATABASE_URL in .env |

---

## 🚨 Rollback Procedure

**If something breaks after deployment:**

1. **Quick Revert (Via Git):**
   ```bash
   git log --oneline | head -5
   # Find commit before your changes
   git revert <commit-hash>
   git push origin main
   # Render auto-deploys the revert
   ```

2. **Manual Rollback (Via Render):**
   - Go to Render Dashboard
   - "hurrypos-backend" → "Deploys" tab
   - Find previous successful deploy
   - Click "Redeploy"

3. **Verify Rollback:**
   ```bash
   curl https://hurrypos-backend.onrender.com/api/printer-settings/status
   ```

---

## 📚 Related Documentation

- **Frontend Changes:** `/hurryposdash-vite/ELECTRON_V17_DEPLOYMENT_GUIDE.md`
- **CI/CD Pipeline:** `/.github/workflows/build-windows.yml`
- **Printer Detection Code:** `/routes/printer.js` (in this directory)
- **Deployment Status:** `DEPLOYMENT_CHECKLIST.md`

---

## 🎯 Next Steps

**After successful backend deployment:**

1. ✅ Backend deployed ← **You are here**
2. ⬜ Frontend testing (test LAN scan in Electron app)
3. ⬜ Create production release tag (v17.0.0)
4. ⬜ Trigger GitHub Actions build

---

## 📝 Deployment Log

| Date | Action | Status | Notes |
|------|--------|--------|-------|
| Jan 2025 | Initial code changes | ✅ | ESC/POS fingerprinting added |
| TBD | Deploy to Render | ⏳ | In progress |
| TBD | Verify endpoints | ⏳ | Pending |
| TBD | Frontend testing | ⏳ | Pending |

---

## 💬 Support

For issues:
1. Check Render dashboard logs
2. Review `DEPLOYMENT_CHECKLIST.md` for common issues
3. Test individual endpoints with curl
4. Check backend `server.js` for CORS config

---

## 🔐 Security Notes

- Database credentials in Render dashboard (not in repo)
- JWT_SECRET rotated recently (beypro_secret_2025)
- CORS configured for frontend and Electron app only
- Network printer probing limited to common subnets (192.168.x.x, 10.0.x.x)

---

**Ready to deploy? Run:**
```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend
./deploy-backend.sh
```
