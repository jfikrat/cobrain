
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

### Tailwind CSS

This project uses Tailwind CSS 3 with PostCSS. CSS must be pre-compiled.

```bash
# Build CSS (production, minified)
bun run build:css

# Watch mode (development)
bun run dev:css
```

**File structure:**
- `src/web/public/styles/input.css` - Tailwind directives + CSS variables + @apply classes
- `src/web/public/styles/output.css` - Compiled CSS (gitignored)
- `tailwind.config.ts` - Custom colors, animations, fonts
- `postcss.config.js` - PostCSS plugins

**Custom colors (CSS variables for theming):**
- `bg-primary`, `bg-secondary`, `bg-tertiary`, `bg-hover`
- `text-primary`, `text-secondary`, `text-muted`
- `accent-primary`, `accent-secondary`
- `border`, `border-hover`
- `success`, `warning`, `error`

**cn() helper for conditional classes:**
```tsx
import { cn } from "../utils/helpers";

<div className={cn(
  "base-class",
  isActive && "active-class",
  variant === "primary" && "bg-accent-primary"
)} />
```

### Server

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  websocket: {
    open: (ws) => ws.send("Hello, world!"),
    message: (ws, message) => ws.send(message),
    close: (ws) => {}
  },
  development: { hmr: true, console: true }
})
```

### HTML imports

HTML files can import .tsx, .jsx or .js files directly. Bun's bundler transpiles & bundles automatically.

```html#index.html
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="./app.tsx"></script>
  </body>
</html>
```

```tsx#app.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/output.css";  // Import compiled Tailwind CSS

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
```

### Development

```bash
# Terminal 1: CSS watch
bun run dev:css

# Terminal 2: Server with HMR
bun --hot src/index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## WhatsApp Proactive Context

WhatsApp mesajları Cobrain AI conversation context'ine otomatik inject edilir.

**Akış:**
```
WA mesaj → proactive.ts (30s poll, Haiku classify) → session-state.json (recentWhatsApp[])
→ chat.ts (DynamicContext populate) → prompts.ts (<recent-whatsapp> XML) → AI context
```

**Dosyalar:**
- `src/services/session-state.ts` — `WhatsAppNotification` tipi, `addWhatsAppNotification()` helper, max 10 entry, 24h TTL
- `src/services/proactive.ts` — Her tier (DM 1/2/3 + Group) sonrası session state update (`appConfig.FF_SESSION_STATE` flag)
- `src/agent/prompts.ts` — `DynamicContext.recentWhatsApp` + `<recent-whatsapp>` XML bloğu
- `src/agent/chat.ts` — Session state'den WA mesajları okuyup DynamicContext'e map etme

**Feature flag:** `FF_SESSION_STATE` — kapalıysa WA context devre dışı

## Self-Management

### Restart
Kod değişikliği yaptıktan veya güncelleme deploy ettikten sonra kendini yeniden başlatmak için:
```bash
cobrain-restart
```
Bu komut 2 saniye sonra restart planlar, böylece cevabını göndermeye zaman kalır.

### Deploy Flow
1. Kodu düzenle (Edit/Write)
2. `git add . && git commit -m "message" && git push fjds main`
3. `cobrain-restart` çağır
4. Kullanıcıya "Değişiklikler deploy edildi, restart ediyorum" de
