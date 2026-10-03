# 部署到云服务器（不用一直开着自己的电脑）

把 KataGo 部署到一台 24 小时在线的 Linux 服务器上，网页就能一直下棋，不需要你电脑开着。

## 一键部署（拿到服务器后）

```bash
# 1) 把仓库拉到服务器（或者只下这一份目录也行）
git clone --depth 1 https://github.com/owdnys/Go-KataGo.git /tmp/gk

# 2) 跑部署脚本（root）
sudo bash /tmp/gk/deploy/deploy-katago-server.sh
```

脚本会自动完成：

1. 安装依赖（含 Node.js 20）
2. 准备 KataGo 引擎 —— **apt 包 → 官方预编译包 → 源码编译** 三级 fallback（ARM64/x64 自动识别）
3. 放置神经网络模型（随包的 `model.txt.gz`，b6c96 小网络）
4. 部署网页桥接服务，生成带**随机访问令牌**的 `engine.json`
5. 注册 systemd 服务 `go-katago`（开机自启、崩溃自重启）
6. 放行端口（iptables / firewalld）

跑完会打印：

```
访问地址 : http://<公网IP>:3210/
访问令牌 : xxxxxxxxxxxxxxxxxxxxxxxx
```

浏览器打开那个地址即可下棋（页面和引擎同源，没有跨域问题）。

可选环境变量：

```bash
sudo PORT=3210 THREADS=2 bash deploy-katago-server.sh
```

## ⚠️ Oracle Cloud 的两个坑

1. **端口要在控制台放行**：脚本只能改服务器内部防火墙，
   Oracle 还需要在 **实例 → 子网 → 安全列表(Security List) → 添加入站规则**
   （源 `0.0.0.0/0`，协议 TCP，目标端口 `3210`），否则外网访问不到。
2. **免费 ARM 额度已被砍半**：2026 年 6 月起从 4 核/24GB 变成 **2 核/12GB**。
   2 核 ARM 跑 KataGo 大概只有一台普通 4 核 x86 笔记本的一半速度，
   建议 `THREADS` 就填核数（2），棋力档位用「快速/标准」更合适。

## 常用维护命令

```bash
systemctl status go-katago        # 状态
systemctl restart go-katago       # 重启
journalctl -u go-katago -f        # 实时日志
nano /opt/go-katago/web/engine.json   # 改端口/线程数/令牌（改完 restart）
```

## 换更强的模型？

默认用 b6c96（4.7MB，快）。想换更大的网络，把新模型放到
`/opt/go-katago/model/` 并改 `engine.json` 里的 `model` 路径即可，
但在 2 核 ARM 上大模型会明显变慢。

## 安全提醒

`engine.json` 里的 `token` 是随机生成的。**如果设了 token**，
任何知道地址的人也必须带上令牌才能调用引擎；若把 token 清空，
则任何拿到地址的人都能用你的引擎（费你的 CPU）。分享地址时请一起决定要不要给令牌。

网页端在「引擎地址」里填 `http://<公网IP>:3210` 和对应令牌即可
（若直接打开 `http://<公网IP>:3210/` 则是同源，无需填写）。
