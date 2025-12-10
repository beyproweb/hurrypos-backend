# HurryPOS Backend

Backend server for the HurryPOS restaurant management system.

## Environment Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and update with your values:

```bash
cp .env.example .env
```

Key variables to set:

- `NODE_ENV` - Set to `development` or `production`
- `PORT` - Server port (default: 5000)
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - Database credentials
- `JWT_SECRET` - Generate with: `openssl rand -base64 32`

## Running the Server

### Development Mode (with local dev origins allowed)

```bash
npm run dev
```

This will:

- Enable all localhost/127.0.0.1 CORS origins (5173, 8081, 3000, etc.)
- Show detailed logging
- Allow connections from Expo dev servers

### Production Mode (secure, only production domains allowed)

```bash
npm start
```

This will:

- Only allow configured production domains (pos.beypro.com, etc.)
- Run with production CORS settings
- Production-optimized logging

## CORS Configuration

### Development Origins (auto-enabled with `npm run dev`)

- `http://localhost:5173` - Vite dev server
- `http://localhost:8081` - Expo web dev server
- `http://localhost:3000` - React dev server
- `http://10.55.189.102:8081` - Local network dev server
- And more localhost variants

### Production Origins (auto-enabled with `npm start`)

- `https://pos.beypro.com`
- `https://www.pos.beypro.com`
- `https://hurrypos-frontend.onrender.com`
- `https://beypro.com`
- `https://www.beypro.com`

## Database Setup

Ensure PostgreSQL is running and create the database:

```bash
createdb hurrypos
psql -U postgres -d hurrypos -f migrations/schema.sql
```

## Monitoring

### View Backend Logs

When running `npm run dev` or `npm start`, the server will output:

```
🚀 Starting backend in DEVELOPMENT mode
📍 Allowed CORS origins (DEV):
   - http://localhost:5173
   - http://localhost:8081
   ...
✅ Backend running on http://localhost:5000
   Environment: 🔧 DEVELOPMENT
   Port: 5000
```

## Troubleshooting

### Port Already in Use

Change the port:

```bash
PORT=5001 npm run dev
```

### CORS Error

Make sure:

1. Backend is running in dev mode for local development
2. Frontend origin is in the allowed origins list
3. Browser console shows which origin was blocked

### Database Connection Error

Check:

1. PostgreSQL is running: `psql --version`
2. Database exists: `psql -l | grep hurrypos`
3. `.env` file has correct credentials

## Architecture

- **Framework**: Express.js
- **Database**: PostgreSQL
- **Auth**: JWT tokens
- **Cache**: Redis (optional)
- **Real-time**: Socket.io (for kitchen orders, etc.)
