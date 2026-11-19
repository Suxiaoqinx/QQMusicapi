/**
 * QQ Music API - 纯 JS 服务端入口 (Koa).
 *
 * 该文件合并自原 TS 项目的:
 *   - web/app.ts (Koa 应用装配)
 *   - web/server.ts (独立服务启动)
 *   - web/_helpers.ts (ok()/fail()/errorHandler)
 *   - web/credentialStore.ts (凭证文件存储)
 *   - web/routes/search.ts, song.ts, user.ts, login.ts (业务路由)
 *
 * 仅保留 API 路由, 移除静态文件 / Web UI / NO_WEB_UI 开关.
 *
 * 环境变量:
 *   PORT             监听端口 (默认 3300)
 *   DEVICE_PATH      设备信息持久化路径 (默认 ./device.json)
 *   CREDENTIAL_PATH  凭证持久化路径 (默认 ./credential.json)
 *   PLATFORM         请求平台: android / desktop / web (默认 android)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import Router from "@koa/router";

import { Client } from "./client.js";
import { Platform } from "./versioning.js";
import { Credential } from "./models/credential.js";
import { SearchType } from "./modules/search.js";
import { parseSongFileType } from "./modules/song_filetype.js";
import { QrLoginType } from "./modules/login.js";
import { qrcDecrypt } from "./algorithms/qrc.js";
import NodeID3 from "node-id3";

// ==================== 响应辅助 ====================

/** 统一成功响应 */
function ok(data, meta) {
  return { code: 0, message: "ok", data, ...(meta ? { meta } : {}) };
}

/** 统一失败响应 */
function fail(code, message, data) {
  return { code, message, data };
}

/**
 * 将异步路由抛出的异常统一序列化为 JSON.
 */
async function errorHandler(ctx, next) {
  try {
    await next();
  } catch (e) {
    const err = e;
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    ctx.status = status;
    ctx.body = fail(err.code ?? status, err.message || "Internal Server Error", err.data);
    if (status >= 500) {
      console.error("[qqmusic-api]", err);
    }
  }
}

// ==================== 凭证存储 ====================

/**
 * 凭证文件存储.
 * 启动时从文件加载凭证,后续每次更新都原子写入磁盘.
 * 文件格式: JSON, 与 Credential.toJSON() 输出一致.
 */
class CredentialStore {
  constructor(options = {}) {
    this._path = options.path
      ? isAbsolute(options.path)
        ? options.path
        : resolve(options.path)
      : resolve("./credential.json");
    this._credential = this._load();
    this._writeQueue = Promise.resolve();
  }

  /** 当前凭证的引用(外部修改不会自动落盘, 请使用 replace) */
  get credential() {
    return this._credential;
  }

  /** 凭证文件路径 */
  get path() {
    return this._path;
  }

  /** 替换当前凭证并原子写入文件 */
  async replace(credential) {
    const next = credential instanceof Credential ? credential : new Credential(credential);
    this._credential = next;
    await this._persist();
    return next;
  }

  /** 与现有凭证合并并写入 */
  async merge(patch) {
    const merged = new Credential({ ...this._credential.toJSON(), ...patch });
    this._credential = merged;
    await this._persist();
    return merged;
  }

  /** 清空凭证 (仅清除 musickey/musicid, 保留 device) */
  async clear() {
    this._credential = new Credential();
    await this._persist();
  }

  /** 返回脱敏后的凭证(用于前端展示,隐藏 musickey/openid 等敏感字段) */
  toSafeJSON(includeSensitive = false) {
    const raw = this._credential.toJSON();
    if (includeSensitive) return raw;
    const safe = {};
    for (const [k, v] of Object.entries(raw)) {
      if (this._isSensitive(k)) {
        safe[k] = v ? "***" : "";
      } else {
        safe[k] = v;
      }
    }
    return safe;
  }

  _isSensitive(key) {
    return [
      "musickey",
      "openid",
      "unionid",
      "accessToken",
      "refreshToken",
      "refreshKey",
      "encryptUin",
    ].includes(key);
  }

  _load() {
    if (!existsSync(this._path)) return new Credential();
    try {
      const raw = JSON.parse(readFileSync(this._path, "utf-8"));
      return new Credential(raw);
    } catch {
      return new Credential();
    }
  }

  async _persist() {
    // 串行化写操作, 避免并发覆盖
    this._writeQueue = this._writeQueue.then(() => this._doWrite());
    await this._writeQueue;
  }

  _doWrite() {
    return new Promise((resolve, reject) => {
      try {
        const dir = dirname(this._path);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${this._path}.tmp`;
        const json = JSON.stringify(this._credential.toJSON(), null, 2);
        writeFileSync(tmp, json, "utf-8");
        renameSync(tmp, this._path);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }
}

// ==================== 路由: /search ====================

function searchRouter(client) {
  const router = new Router({ prefix: "/search" });

  router.get("/hotkey", async (ctx) => {
    ctx.body = ok(await client.search.getHotkey());
  });

  router.get("/complete", async (ctx) => {
    const keyword = String(ctx.query.keyword ?? "");
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(await client.search.complete(keyword));
  });

  router.get("/quick", async (ctx) => {
    const keyword = String(ctx.query.keyword ?? "");
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(await client.search.quickSearch(keyword));
  });

  router.post("/general", async (ctx) => {
    const body = ctx.request.body ?? {};
    const { keyword, page, num, searchid, pageStart, highlight } = body;
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(
      await client.search.generalSearch(
        keyword,
        page ?? 1,
        num ?? 15,
        searchid ?? null,
        pageStart ?? null,
        highlight ?? true,
      ),
    );
  });

  router.post("/byType", async (ctx) => {
    const body = ctx.request.body ?? {};
    const { keyword, type, num, page, searchid, highlight } = body;
    if (!keyword) ctx.throw(400, "keyword 必填");
    ctx.body = ok(
      await client.search.searchByType(
        keyword,
        type ?? SearchType.SONG,
        num ?? 10,
        page ?? 1,
        searchid ?? null,
        highlight ?? true,
      ),
    );
  });

  return router;
}

// ==================== 路由: /song ====================

/**
 * LRC/QRC 歌词文本清洗为 iTunes 可显示的纯文本:
 * - 丢弃 [ti:/ar:/al:/by:/offset:] 等元数据行
 * - 去掉行首时间戳标签 ([00:12.34] / [8664,3740] 等)
 */
function cleanLrcText(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const s = line.trimEnd();
    if (/^\[(ti|ar|al|by|offset|total|length|re|ve|hash|encoding):/i.test(s)) continue;
    const text = s.replace(/^(\[[^\]]*\]\s*)+/, "").trimEnd();
    if (text || (out.length > 0 && out[out.length - 1] !== "")) out.push(text);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function songRouter(client) {
  const router = new Router({ prefix: "/song" });

  router.get("/detail", async (ctx) => {
    const mids = String(ctx.query.mids ?? "").split(",").filter(Boolean);
    if (mids.length === 0) ctx.throw(400, "mids 必填");
    ctx.body = ok(await client.song.getDetail(mids));
  });

  router.get("/urls", async (ctx) => {
    const mids = String(ctx.query.mids ?? "").split(",").filter(Boolean);
    if (mids.length === 0) ctx.throw(400, "mids 必填");
    const typeStr = String(ctx.query.type ?? "MP3_128");
    const fileType = parseSongFileType(typeStr) ?? typeStr;
    ctx.body = ok(await client.song.getPlayUrls(mids, fileType));
  });

  router.get("/lyric", async (ctx) => {
    const mid = String(ctx.query.mid ?? "");
    if (!mid) ctx.throw(400, "mid 必填");
    const wantDecode = String(ctx.query.decode ?? "1") !== "0";
    const data = await client.song.getLyrics(mid, { trans: true, roma: false, qrc: true });
    const out = { raw: data };
    if (wantDecode) {
      try {
        if (data.crypt === 1) {
          if (data.lyric) out.lyric = qrcDecrypt(data.lyric);
          if (data.trans) out.trans = qrcDecrypt(data.trans);
          if (data.roma) out.roma = qrcDecrypt(data.roma);
        } else {
          // 后端未加密, 直接透传
          out.lyric = data.lyric ?? "";
          out.trans = data.trans ?? "";
          out.roma = data.roma ?? "";
        }
      } catch (e) {
        out.decodeError = `QRC 解密失败: ${e.message}`;
      }
    }
    ctx.body = ok(out);
  });

  router.get("/similar", async (ctx) => {
    const songid = ctx.query.songid ?? ctx.query.id;
    if (!songid) ctx.throw(400, "songid 必填 (数字歌曲 ID)");
    const data = await client.song.getSimilar(String(songid));
    // 展开: 把 [group.songs[].track] 展平成一维数组
    const list = [];
    for (const group of data?.vecSongNew ?? []) {
      for (const entry of group.songs ?? []) {
        if (entry?.track) list.push(entry.track);
      }
    }
    ctx.body = ok({ list, groups: data?.vecSongNew ?? [] });
  });

  router.get("/relatedSonglist", async (ctx) => {
    const mid = String(ctx.query.mid ?? "");
    if (!mid) ctx.throw(400, "mid 必填");
    ctx.body = ok(await client.song.getRelatedSonglist(mid));
  });

  // 下载音频文件, MP3 档自动写入 ID3 标签(歌名/歌手/专辑/封面), 文件名 "歌名 - 歌手.mp3"
  router.get("/download", async (ctx) => {
    const mid = String(ctx.query.mid ?? "");
    if (!mid) ctx.throw(400, "mid 必填");
    const typeStr = String(ctx.query.type ?? "M500").toUpperCase();

    // 1. 获取直链
    const urls = await client.song.getPlayUrls([mid], parseSongFileType(typeStr) ?? typeStr);
    const info = urls?.[mid];
    if (!info?.url) ctx.throw(502, info?.error || "无可用直链");

    // 2. 并发: 下载音频 + 歌曲详情
    const [audioResp, detail] = await Promise.all([
      fetch(info.url),
      client.song.getDetail([mid]).catch(() => ({ tracks: [] })),
    ]);
    if (!audioResp.ok) ctx.throw(502, `音频下载失败: HTTP ${audioResp.status}`);
    const audioBuf = Buffer.from(await audioResp.arrayBuffer());

    // 3. 组装标签信息
    const track = detail?.tracks?.[0];
    const title = String(track?.name || mid);
    const artist = Array.isArray(track?.singer)
      ? track.singer.map((s) => s.name).join("/")
      : String(track?.singer || "");
    const album = String(track?.album?.name || "");
    const albumMid = String(track?.album?.mid || "");

    // 4. 文件名: 歌名 - 歌手.mp3 (过滤 Windows 非法字符)
    const safe = (s) => s.replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
    const urlExt = info.url.match(/\.(mp3|m4a|ogg|flac|nac)(?:$|\?)/i)?.[1]?.toLowerCase();
    const ext = urlExt || "mp3";
    const base = `${safe(title) || mid} - ${safe(artist) || "未知歌手"}`;

    let body = audioBuf;
    // 5. 仅 MP3 档嵌入 ID3v2 标签 + 封面 + 歌词
    if (ext === "mp3") {
      let coverBuf = null;
      if (albumMid) {
        try {
          const cResp = await fetch(
            `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`,
          );
          if (cResp.ok) coverBuf = Buffer.from(await cResp.arrayBuffer());
        } catch {
          // 封面失败不阻塞下载
        }
      }
      const frames = { title, artist, album };
      if (coverBuf && coverBuf.length > 0) {
        // 注意: node-id3 0.2.9 中 data 别名已失效, 必须用 imageBuffer, 否则封面帧被静默丢弃
        frames.image = { mime: "image/jpeg", type: 3, description: "Cover", imageBuffer: coverBuf };
      }
      // 歌词: 请求 LRC(qrc:false 返回加密数据) -> 解密 -> 去时间戳纯文本 -> USLT 帧 (iTunes 原生读取)
      // 注: qrc:true 直接返回 QRC XML(逐字时间轴), 不适合嵌入; qrc:false + qrcDecrypt 得到标准行级 LRC
      try {
        const lyr = await client.song.getLyrics(mid, { qrc: false, trans: false, roma: false });
        const rawLrc = lyr?.crypt === 1 && lyr?.lyric ? qrcDecrypt(lyr.lyric) : lyr?.lyric ?? "";
        const plain = cleanLrcText(rawLrc);
        if (plain) {
          frames.unsynchronisedLyrics = { language: "eng", description: "", text: plain };
        }
      } catch {
        // 歌词失败不阻塞下载
      }
      try {
        body = NodeID3.write(frames, audioBuf);
      } catch {
        body = audioBuf; // 写标签失败时回退原始文件
      }
    }

    ctx.set("Content-Type", "application/octet-stream");
    ctx.set("Content-Length", String(body.length));
    ctx.set(
      "Content-Disposition",
      `attachment; filename="download.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`,
    );
    ctx.body = body;
  });

  return router;
}

// ==================== 路由: /user ====================

function userRouter(client) {
  const router = new Router({ prefix: "/user" });

  router.get("/self", async (ctx) => {
    ctx.body = ok(await client.user.getSelfInfo());
  });

  router.get("/info", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    ctx.body = ok(await client.user.getUserInfo(uin));
  });

  router.get("/songlist", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    const page = Number(ctx.query.page ?? 1);
    const num = Number(ctx.query.num ?? 30);
    ctx.body = ok(await client.user.getUserSonglist(uin, page, num));
  });

  router.get("/follows", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    const page = Number(ctx.query.page ?? 1);
    const num = Number(ctx.query.num ?? 30);
    ctx.body = ok(await client.user.getUserFollows(uin, page, num));
  });

  router.get("/fans", async (ctx) => {
    const uin = String(ctx.query.uin ?? "");
    if (!uin) ctx.throw(400, "uin 必填");
    const page = Number(ctx.query.page ?? 1);
    const num = Number(ctx.query.num ?? 30);
    ctx.body = ok(await client.user.getUserFans(uin, page, num));
  });

  router.post("/follow", async (ctx) => {
    const body = ctx.request.body ?? {};
    const uin = String(body.uin ?? "");
    const follow = Boolean(body.follow ?? true);
    if (!uin) ctx.throw(400, "uin 必填");
    ctx.body = ok(await client.user.follow(uin, follow));
  });

  return router;
}

// ==================== 路由: /login ====================

function loginRouter(client, store) {
  const router = new Router({ prefix: "/login" });

  /** 同步内存凭证与 store (启动时已加载, 这里只保证运行时一致) */
  const syncClient = () => {
    client.credential = store.credential;
  };

  router.get("/status", async (ctx) => {
    const expired = store.credential.musickey
      ? await client.login.checkExpired(store.credential)
      : false;
    ctx.body = ok({
      loggedIn: store.credential.isLoggedIn(),
      expired,
      musicid: store.credential.musicid || null,
      file: store.path,
    });
  });

  router.get("/credential", async (ctx) => {
    const includeSensitive = String(ctx.query.raw ?? "") === "1";
    ctx.body = ok({
      credential: store.toSafeJSON(includeSensitive),
      file: store.path,
    });
  });

  router.put("/credential", async (ctx) => {
    const body = ctx.request.body ?? {};
    const saved = await store.replace(body);
    syncClient();
    ctx.body = ok(saved.toJSON());
  });

  router.delete("/credential", async (ctx) => {
    await store.clear();
    syncClient();
    ctx.body = ok({ ok: true });
  });

  router.post("/refresh", async (ctx) => {
    const newCred = await client.login.refreshCredential(store.credential);
    await store.replace(newCred);
    syncClient();
    ctx.body = ok(newCred.toJSON());
  });

  router.post("/logout", async (ctx) => {
    try {
      await client.login.logout(store.credential);
    } catch {
      // 即使服务端登出失败也允许本地清空
    }
    await store.clear();
    syncClient();
    ctx.body = ok({ ok: true });
  });

  router.post("/qrcode", async (ctx) => {
    const body = ctx.request.body ?? {};
    const typeStr = String(body.type ?? "qq");
    const type = typeStr === "wx" ? QrLoginType.WX : typeStr === "mobile" ? QrLoginType.MOBILE : QrLoginType.QQ;
    const qr = await client.login.getQrcode(type);
    ctx.body = ok({
      type: qr.type,
      mime: qr.mime,
      identifier: qr.identifier,
      // 返回 base64 便于前端展示
      data: qr.data.toString("base64"),
    });
  });

  router.post("/checkQrcode", async (ctx) => {
    const body = ctx.request.body ?? {};
    const identifier = String(body.identifier ?? "");
    const type = String(body.type ?? "qq");
    if (!identifier) ctx.throw(400, "identifier 必填");
    const result = await client.login.checkQrcode({
      identifier,
      type: type === "wx" ? QrLoginType.WX : QrLoginType.QQ,
      data: Buffer.alloc(0),
      mime: "",
    });
    let saved = null;
    if (result.credential) {
      await store.replace(result.credential);
      syncClient();
      saved = result.credential.toJSON();
    }
    ctx.body = ok({
      event: result.event,
      credential: saved,
    });
  });

  router.post("/sendAuthcode", async (ctx) => {
    const body = ctx.request.body ?? {};
    const phone = body.phone;
    const countryCode = Number(body.countryCode ?? 86);
    if (phone === undefined) ctx.throw(400, "phone 必填");
    ctx.body = ok(await client.login.sendAuthcode(phone, countryCode));
  });

  router.post("/phone", async (ctx) => {
    const body = ctx.request.body ?? {};
    const phone = body.phone;
    const code = String(body.code ?? "");
    if (phone === undefined || !code) ctx.throw(400, "phone 和 code 必填");
    const cred = await client.login.phoneAuthorize(phone, code);
    await store.replace(cred);
    syncClient();
    ctx.body = ok(cred.toJSON());
  });

  return router;
}

// ==================== 应用装配 ====================

function createApp(options = {}) {
  const devicePath = options.devicePath;
  const credentialPath = options.credentialPath;

  // 1. 创建凭证存储, 优先于 Client 初始化(让 Client 直接持有 store 内的凭证)
  const store = new CredentialStore({ path: credentialPath });

  // 2. 创建 Client, 用 store 中的凭证进行初始化
  const client = new Client({
    platform: options.platform ?? Platform.ANDROID,
    devicePath,
    credential: store.credential.toJSON(),
  });

  const app = new Koa();
  app.use(errorHandler);
  app.use(bodyParser({ jsonLimit: "1mb" }));

  // 3. 健康检查 + 首页
  const root = new Router();
  root.get("/health", (ctx) => {
    ctx.body = ok({
      status: "ok",
      time: new Date().toISOString(),
      loggedIn: store.credential.isLoggedIn(),
      musicid: store.credential.musicid || null,
    });
  });

  // 首页: 读取 src/public/index.html 并返回
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PUBLIC_DIR = join(__dirname, "public");
  const INDEX_HTML_PATH = join(PUBLIC_DIR, "index.html");
  const LOGIN_HTML_PATH = join(PUBLIC_DIR, "login.html");
  let indexHtmlCache = null;
  let loginHtmlCache = null;
  root.get("/", (ctx) => {
    ctx.type = "text/html; charset=utf-8";
    if (!indexHtmlCache) {
      indexHtmlCache = existsSync(INDEX_HTML_PATH)
        ? readFileSync(INDEX_HTML_PATH, "utf-8")
        : "<h1>QQ Music API</h1><p>index.html not found at " + INDEX_HTML_PATH + "</p>";
    }
    ctx.body = indexHtmlCache;
  });
  root.get("/login", (ctx) => {
    ctx.type = "text/html; charset=utf-8";
    if (!loginHtmlCache) {
      loginHtmlCache = existsSync(LOGIN_HTML_PATH)
        ? readFileSync(LOGIN_HTML_PATH, "utf-8")
        : "<h1>QQ Music Login</h1><p>login.html not found at " + LOGIN_HTML_PATH + "</p>";
    }
    ctx.body = loginHtmlCache;
  });
  app.use(root.routes());

  // 4. 业务路由
  app.use(searchRouter(client).routes());
  app.use(songRouter(client).routes());
  app.use(userRouter(client).routes());
  app.use(loginRouter(client, store).routes());

  return Object.assign(app, { client, store });
}

// ==================== 启动入口 ====================

const PORT = Number(process.env.PORT ?? 3300);
const DEVICE_PATH = process.env.DEVICE_PATH ?? "./device.json";
const CREDENTIAL_PATH = process.env.CREDENTIAL_PATH ?? "./credential.json";
const PLATFORM_STR = process.env.PLATFORM ?? "android";
const PLATFORM =
  PLATFORM_STR === "desktop" ? Platform.DESKTOP :
  PLATFORM_STR === "web" ? Platform.WEB :
  Platform.ANDROID;

const app = createApp({
  devicePath: DEVICE_PATH,
  credentialPath: CREDENTIAL_PATH,
  platform: PLATFORM,
});

app.listen(PORT, () => {
  console.log(`[qqmusic-api] listening on http://localhost:${PORT}`);
  console.log(`[qqmusic-api] device path     : ${DEVICE_PATH}`);
  console.log(`[qqmusic-api] credential path : ${CREDENTIAL_PATH}`);
  console.log(`[qqmusic-api] platform        : ${PLATFORM}`);
});
