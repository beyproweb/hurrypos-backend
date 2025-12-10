# Backend Dev & Prod Setup ✅

## Quick Start

### Development Mode (Local Testing)

```bash
cd /Users/nurikord/PycharmProjects/hurrypos-backend
npm run dev
```

**Output:**

```
🚀 Starting backend in DEVELOPMENT mode
📍 Allowed CORS origins (DEV):
   - http://localhost:5173
   - http://localhost:5174
   - http://localhost:8081
   - http://localhost:3000
   - http://localhost:3001
   - http://10.55.189.102:8081
   - http://127.0.0.1:5173
   - http://127.0.0.1:8081

✅ Backend running on http://localhost:5000
   Environment: 🔧 DEVELOPMENT
   Port: 5000
   LAN accessible: http://0.0.0.0:5000
```

### Production Mode (Deployment)

```bash
npm start
```

**Output:**

```
🚀 Starting backend in PRODUCTION mode
📍 Allowed CORS origins (PROD):
   - https://pos.beypro.com
   - https://www.pos.beypro.com
   - https://hurrypos-frontend.onrender.com
   - https://beypro.com
   - https://www.beypro.com

✅ Backend running on https://pos.beypro.com
   Environment: 🚀 PRODUCTION
   Port: 5000
```

## Features

✅ **Environment-aware CORS**

- Dev: All localhost and local network origins allowed
- Prod: Only production domains allowed

✅ **Easy switching**

- `npm run dev` - Development mode
- `npm start` - Production mode

✅ **Environment variables**

- Automatically set `NODE_ENV` to development or production
- Supports custom `PORT` via `.env` or environment

✅ **Better logging**

- Shows which mode is running
- Lists allowed CORS origins
- Clear startup messages

## Configuration

### .env file

```
NODE_ENV=development
PORT=5000
DB_HOST=localhost
DB_NAME=hurrypos
JWT_SECRET=your_secret_here
```

See `.env.example` for all available options.

## Troubleshooting

### Development app can't reach backend?

1. Make sure `npm run dev` is running
2. Check CORS origin is listed in dev origins
3. Use `http://localhost:5000` (not https) in dev

### Production CORS error?

1. Make sure `npm start` is running
2. Only production domains (https://...) are allowed
3. Check domain is in production origins list

## Next Steps

1. Run mobile app in dev:

   ```bash
   cd beypro-admin-mobile
   npx expo start
   ```

2. Run web dashboard in dev:

   ```bash
   cd hurryposdashboard/hurryposdash-vite
   npm run dev
   ```

3. Run backend in dev:
   ```bash
   cd hurrypos-backend
   npm run dev
   ```

All three should now connect without CORS errors! 🎉
