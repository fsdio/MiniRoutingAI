// tests/preload-env.ts — set env sebelum semua test agar src/index.ts tidak bind port
process.env.MINI_NO_LISTEN = "1";
