# QQMusic API for Node.js

> **注意**：本项目仅用于技术研究与学习，请勿用于侵犯版权或其他商业用途，请支持正版音乐。

## ✨ 特性

- **核心客户端** `Client`：封装 HTTP 请求、User-Agent、Cookie、Session、QIMEI 设备指纹
- **请求描述符** `Request`：实现 thenable，可直接 `await`，也支持 `gather` 批量并发
- **签名算法**：`zzc_sign` 签名、自定义 TripleDES 加解密、QRC 歌词解密
- **业务模块**：`search` / `song` / `user` / `login`
- **Koa Web 服务**：REST API + 内置 Web UI（首页解析器 + 登录管理页）
- **APlayer 播放器**：首页集成 [APlayer](https://aplayer.js.org/) 播放器，支持 17 种音质在线试听
- **首页关键词搜索**：搜索框直接搜歌（分页展示），点击结果即可解析试听
- **成品下载**：MP3 档下载时自动写入 ID3 标签（歌名/歌手/专辑）并嵌入 500×500 封面与纯文本歌词，文件名为「歌名 - 歌手.mp3」
- **多平台支持**：Android / Desktop / Web 三种平台版本策略

## 📦 安装

```bash
cd QQMusicapi
npm install
```

要求 Node.js >= 18。

## 🚀 快速开始

### 启动 Web 服务

```bash
# 默认监听 3300 端口
npm start

# 开发模式
npm run dev

# 自定义端口与设备路径
PORT=3000 DEVICE_PATH=./device.json npm start
```

启动后访问：

- **首页解析器**：[http://localhost:3300/](http://localhost:3300/) — 粘贴歌曲链接或 songmid，一键获取 17 种音质直链、歌词、相似歌曲，并使用 APlayer 在线试听
- **登录管理**：[http://localhost:3300/login](http://localhost:3300/login) — 支持 QQ 二维码登录与手机验证码登录，查看当前用户信息

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3300` | 监听端口 |
| `DEVICE_PATH` | `./device.json` | 设备信息持久化路径 |
| `CREDENTIAL_PATH` | `./credential.json` | 凭证持久化路径 |
| `PLATFORM` | `android` | 请求平台：`android` / `desktop` / `web` |
| `QQMUSIC_DEBUG` | - | 设为 `1` 时输出 check_sig 等调试日志 |

## 🌐 Web API

### 通用约定

- 所有响应均为 JSON，格式：`{ code, message, data, meta? }`
- `code === 0` 表示成功，非零表示失败
- POST 请求使用 `application/json` body

### 路由列表

#### 基础

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/` | GET | 首页 Web UI（歌曲解析器） |
| `/login` | GET | 登录管理 Web UI |
| `/health` | GET | 健康检查 |

#### 搜索 `/search`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/search/hotkey` | GET | 热搜词 |
| `/search/complete?keyword=...` | GET | 搜索补全 |
| `/search/quick?keyword=...` | GET | 快速搜索 |
| `/search/general` | POST | 综合搜索 |
| `/search/byType` | POST | 按类型搜索 |

#### 歌曲 `/song`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/song/detail?mids=a,b` | GET | 歌曲详情 |
| `/song/urls?mids=a,b&type=MP3_128` | GET | 播放直链（支持 17 种音质） |
| `/song/download?mid=...&type=M500` | GET | 成品下载（仅 MP3 档自动写入 ID3 标签：歌名/歌手/专辑/封面/歌词，文件名「歌名 - 歌手.mp3」；其他音质档回源直链） |
| `/song/lyric?mid=...&decode=1` | GET | 歌词（自动 QRC 解密） |
| `/song/similar?songid=...` | GET | 相似歌曲 |
| `/song/relatedSonglist?mid=...` | GET | 相关歌单 |

#### 用户 `/user`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/user/self` | GET | 当前登录用户信息 |
| `/user/info?uin=...` | GET | 指定用户信息 |
| `/user/songlist?uin=...&page=1&num=30` | GET | 用户歌单 |
| `/user/follows?uin=...&page=1&num=30` | GET | 关注列表 |
| `/user/fans?uin=...&page=1&num=30` | GET | 粉丝列表 |
| `/user/follow` | POST | 关注 / 取消关注 |

#### 登录 `/login`

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/login/status` | GET | 凭证状态 |
| `/login/credential` | GET | 查看凭证（脱敏） |
| `/login/credential` | PUT | 替换凭证 |
| `/login/credential` | DELETE | 清空凭证 |
| `/login/refresh` | POST | 刷新凭证 |
| `/login/logout` | POST | 登出 |
| `/login/qrcode` | POST | 获取 QQ 登录二维码 |
| `/login/checkQrcode` | POST | 检查二维码状态 |
| `/login/sendAuthcode` | POST | 发送手机验证码 |
| `/login/phone` | POST | 手机验证码登录 |

### 支持的音质

`/song/urls` 接口的 `type` 参数支持以下 17 种音质：

| 代码 | 说明 |
| --- | --- |
| `DT03` | DTS:X |
| `AI00` | 臻品母带 |
| `Q000` | 臻品音质 |
| `Q001` | 臻品全景声 5.1 |
| `Q003` | 臻品全景声 7.1 |
| `D004` | 杜比全景声 |
| `TL01` | AICodec |
| `F000` | SQ 无损 |
| `O801` | OGG 640 |
| `O800` | OGG 320 |
| `O600` | OGG 192 |
| `O400` | OGG 96 |
| `M800` | MP3 320 |
| `M500` | MP3 128 |
| `C600` | ACC 192 |
| `C400` | ACC 96 |
| `C200` | ACC 48 |

## 🖥️ Web UI

### 首页解析器 (`/`)

- 粘贴歌曲链接或 songmid 即可一键解析
- 关键词搜索歌曲（每页 30 条，支持翻页），点击结果直接解析试听
- 展示歌曲信息、封面、专辑、歌手
- 并发获取 17 种音质直链，显示可用 / 不可用状态
- MP3 档「下载」按钮产出带 ID3 标签（歌名/歌手/专辑/封面/歌词）的成品文件
- 集成 [APlayer](https://aplayer.js.org/) 播放器，支持歌曲名称、歌手、封面、播放链接展示
- 歌词多版本切换（原文 / 翻译 / 罗马音）
- 相似歌曲推荐，点击即可跳转解析

### 登录管理 (`/login`)

- **当前登录状态**：展示登录态、musicid、凭证过期标志、凭证文件路径
- **当前用户信息**：头像、昵称
- **QQ 二维码登录**：实时轮询扫码状态（SCAN / CONF / DONE / REFUSE / TIMEOUT）
- **手机验证码登录**：发送验证码（60s 倒计时）并登录
- **凭证管理**：刷新凭证、退出登录

## 📁 项目结构

```
src/
├── algorithms/          # 签名与加解密算法
│   ├── sign.js          # zzc_sign 签名
│   ├── tripledes.js     # TripleDES 加解密
│   └── qrc.js           # QRC 歌词解密
├── models/              # 数据模型
│   ├── credential.js    # 登录凭证
│   └── request.js       # 请求描述符 (thenable)
├── modules/             # 业务模块
│   ├── base.js          # 模块基类
│   ├── search.js        # 搜索
│   ├── song.js          # 歌曲
│   ├── song_filetype.js # 音质类型
│   ├── user.js          # 用户
│   └── login.js         # 登录
├── public/              # Web UI 静态资源
│   ├── index.html       # 首页解析器
│   └── login.html       # 登录管理页
├── utils/               # 工具
│   ├── common.js        # 通用工具
│   ├── device.js        # 设备指纹管理
│   └── qimei.js         # QIMEI 注册
├── client.js            # 核心客户端
├── exceptions.js        # 异常定义
├── server.js            # Koa 服务入口
├── version.js           # 版本号
└── versioning.js        # 平台版本策略
```
