# F-Transfer

Fast, secure, local browser-to-browser file sharing via WebRTC.

## Motivation
Share files securely and instantly between computers on the same network using WebRTC data channels. Data travels directly peer-to-peer and never hits a remote server.

## Stack
- Frontend: Next.js 14 (App Router), Tailwind CSS v4, Lucide React, Framer Motion
- Backend / Signaling: Node.js, `ws`, `uuid`

## Getting Started

First, run the signaling server:
```bash
cd server
npm install
npm start
``` 

Then, run the development server for the Next.js frontend:
```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.
