# NEOTRADE

A professional-grade, lightweight signal-based simulated exchange, with TRON
(TRC20 USDT) deposits/withdrawals and a native Android app.

## Features
- **Signal Notification System**: Real-time signals from admin.
- **Simulated Trading Engine**: Fake market movement and trade execution.
- **Wallet & Deposit System**: One fixed platform TRC20 (USDT) deposit address for every account; deposits are credited by admin.
- **Referral & KYC**: Complete user lifecycle management.
- **Powerful Admin Panel**: Full control over users, signals, and trades.
- **Android app**: Capacitor shell that loads the deployed server (see below).

## Tech Stack
- **Frontend**: Vanilla HTML/JS/CSS, TradingView.
- **Backend**: Node.js, Express, Socket.io.
- **Database**: PostgreSQL (Prisma ORM).
- **Cache**: Redis.
- **Wallet**: Single fixed TRC20 deposit address (TRON mainnet, USDT TRC20).
- **Infrastructure**: Docker.

## Getting Started

1. **Configure environment**: copy `.env.example` to `.env` and fill in real
   values (see comments in the file — SMTP, database, JWT secret, and the
   TRC20 deposit address below). `.env` is git-ignored; never commit it.

2. **Spin up Infrastructure**:
   ```bash
   docker-compose up -d
   ```

3. **Run Migrations**:
   ```bash
   npx prisma migrate dev --name init --schema=backend/prisma/schema.prisma
   ```

4. **Start the Server**:
   ```bash
   npm start
   ```

The app will be available at `http://localhost:3000`.

## Signal Flow
1. Admin creates a signal via `/api/admin/signals`.
2. Users receive a real-time notification on the Home screen.
3. Users click "FOLLOW SIGNAL" to go to the trading screen.
4. Users place a trade before the countdown ends.
5. Signal starts, market movement is simulated.
6. Signal ends, trades are resolved automatically.

## TRC20 deposit address

Every account deposits to the same platform address, set by
`TRC20_RECEIVING_ADDRESS` (default `TFk6S5zkJKuFAb1QjbHDVr2Lv95oSSCYLN`) and
served by `GET /api/wallet/address`. No per-user (parent/child) wallets are
generated, and the address is read only from the server environment — no user
or admin API can change it. No private key or seed phrase is needed. Because all
users share one address, the user submits the TXID of their transfer on the
deposit screen (`POST /api/wallet/deposit/submit`); the backend verifies on
TronGrid that it is a confirmed USDT transfer to the receiving address and
records it as `pending_approval`, and an admin approves it (Admin panel →
Deposits). Each TXID can only be claimed once.

## Android app

The Android app is a Capacitor shell around the deployed server — same
frontend, no bundled backend or API secrets. Build steps:

```bash
npm run android:assets   # regenerate launcher icon + splash from frontend/netrontrade-logo.svg
npm run android:sync     # copy the public frontend into www/ and `cap sync android`
npm run android:debug    # assembleDebug -> android/app/build/outputs/apk/debug/app-debug.apk
npm run android:release  # assembleRelease (unsigned unless NETRONTRADE_KEYSTORE_* env vars are set)
```

`NETRONTRADE_APP_URL` (in `.env`, default `https://netrade.onrender.com`)
is the production URL the APK loads — it must be a public `https://` URL,
never `localhost`. Requires a JDK 17+ and the Android SDK (`ANDROID_HOME`) to
be installed; see `capacitor.config.js` for the rest of the build config.
