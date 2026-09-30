# 部署到 GitHub + Cloudflare Pages（免费域名）

> 先说结论：**如果你只是自己在这台电脑上下棋，不需要部署** —— 双击 `启动围棋.cmd` 就够了。
> 部署的意义是：有一个公网链接可以打开 / 分享，或者用手机、别的电脑来下。
> 但请记住：**公网页面本身没有 AI**，AI 仍然由你电脑上的 KataGo 提供（下面第四节讲怎么连）。

---

## 一、把这个文件夹变成 Git 仓库

在文件夹里打开 PowerShell（地址栏输入 `powershell` 回车），执行：

```powershell
git init
git add .
git commit -m "围棋 KataGo 网页版"
```

`engine.json`（含你的本机路径）已在 `.gitignore` 里，不会被提交。

## 二、上传到 GitHub

### 方式 A：网页上传（不用装任何工具，最省事）

1. 打开 <https://github.com/new>，Repository name 填 `go-katago-web`，选 **Public**，点 Create
2. 在新仓库页面点 **uploading an existing file**
3. 把文件夹里的**所有内容**（`public` 文件夹、`server.js`、`README.md`…）拖进去
   - 注意：`.gitignore` 是隐藏文件，网页上传会跳过它，不影响部署
4. 底部点 **Commit changes**

### 方式 B：GitHub Desktop

1. 装 <https://desktop.github.com>，登录后 `File → Add local repository` 选中本文件夹
2. 点 **Publish repository**（取消勾选 Keep this code private 如果你想公开）

### 方式 C：命令行

先在 GitHub 建好空仓库，然后：

```powershell
git remote add origin https://github.com/<你的用户名>/go-katago-web.git
git branch -M main
git push -u origin main
```

---

## 三、用 Cloudflare Pages 挂上去（免费）

1. 打开 <https://dash.cloudflare.com/> 注册/登录（免费）
2. 左侧 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 授权 GitHub，选中刚建的 `go-katago-web` 仓库 → Begin setup
4. 构建设置按下面填（**重要**）：

   | 项目 | 填什么 |
   | --- | --- |
   | Framework preset | `None` |
   | Build command | **留空** |
   | Build output directory | `public` |

5. 点 **Save and Deploy**，一两分钟后就会拿到一个免费域名：

   ```
   https://go-katago-web.pages.dev
   ```

   以后每次 `git push`，Cloudflare 会自动重新部署。

打开这个域名你会看到棋盘界面，但顶部会提示 **「未连接引擎」**——这是正常的，接着看下一节。

---

## 四、让公网页面上也能下 AI（连回你自己的引擎）

页面本身没有 AI，需要让它连到你电脑上跑的 `server.js` + `katago.exe`。
打开页面后**点顶部状态条**，填入引擎地址即可。

### 情况 1：就在这台电脑上用（不需要填）

直接打开 <http://127.0.0.1:3210/>（双击 `启动围棋.cmd` 会自动开），同源自动连上。

### 情况 2：局域网内用手机 / 另一台电脑访问

1. 把 `engine.json` 里的 `"host": "127.0.0.1"` 改成 `"host": "0.0.0.0"`，重启服务
2. 查本机 IP：`ipconfig`（找 IPv4 地址，形如 `192.168.1.23`）
3. 第一次可能被 Windows 防火墙拦，弹窗选「允许访问」
4. 在页面里填 `http://192.168.1.23:3210`

### 情况 3：从公网访问（Cloudflare 免费隧道）

1. 下载 cloudflared：<https://github.com/cloudflare/cloudflared/releases/latest>
   选 `cloudflared-windows-amd64.exe`，放到任意目录，改名 `cloudflared.exe`
2. 先确保本机引擎在跑（双击 `启动围棋.cmd`）
3. 在同目录打开 PowerShell：

   ```powershell
   .\cloudflared.exe tunnel --url http://127.0.0.1:3210
   ```

4. 屏幕上会打印一个临时公网地址，形如：

   ```
   https://random-words-1234.trycloudflare.com
   ```

5. 把**这个地址**填进网页的引擎地址框 → 连接

> ⚠️ 这个临时地址每次重启隧道都会变，而且**任何拿到地址的人都能用你的引擎**。
> 所以请务必在 `engine.json` 里设置 `"token": "一个只有你知道的字符串"`，
> 重启服务后，在网页的「访问令牌」框里填同样的字符串（别人没有令牌就调不动你的引擎）。

---

## 五、常见问题

**Q：网页上点了没反应？**
A：说明没连上引擎。看顶部状态条是不是「未连接引擎」，点它填地址；本机使用就双击 `启动围棋.cmd`。

**Q：填了地址还是连不上？**
A：依次检查：① 引擎服务是否在跑（浏览器能打开 `http://127.0.0.1:3210/api/status` 吗）；
② 地址是否带 `http://` 或 `https://`、端口是否对；③ 隧道用 https 地址；
④ 令牌是否和 `engine.json` 一致；⑤ 浏览器控制台（F12）里有没有 CORS/网络错误。

**Q：明明部署好了，为什么 Cloudflare 上不能跑 KataGo？**
A：KataGo 是需要本机 CPU/GPU 和模型文件的原生程序，静态托管平台只能发网页文件，跑不了它。
本项目把「界面」和「引擎」分开，正是为了这一点。

**Q：`engine.json` 会不会被传上 GitHub？**
A：不会，`.gitignore` 里已排除。仓库里给的是 `engine.example.json` 模板。

**Q：想改界面文字 / 配色？**
A：`public/style.css` 顶部是主题变量，`public/index.html` 是结构，`public/app.js` 是逻辑。
