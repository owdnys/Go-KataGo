#!/usr/bin/env bash
# ============================================================================
#  围棋 · KataGo 云端一键部署（Linux ARM64 / x86_64）
#
#  用法（在服务器上，root 权限）：
#      sudo bash deploy-katago-server.sh
#
#  它会把 KataGo 引擎 + 神经网络 + 网页桥接服务装好，并注册成开机自启的系统服务。
#  装完后用 http://<服务器公网IP>:3210/ 就能下棋。
#
#  环境变量（可选）：
#      PORT=3210              监听端口
#      INSTALL_DIR=/opt/go-katago
#      THREADS=<CPU核数>      搜索线程数
#      TOKEN=xxxx             访问令牌（不给则随机生成）
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/go-katago}"
PORT="${PORT:-3210}"
REPO_URL="${REPO_URL:-https://github.com/owdnys/Go-KataGo.git}"
KATAGO_VERSION="${KATAGO_VERSION:-v1.16.3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"

case "$(uname -m)" in
  aarch64|arm64) KARCH=arm64 ;;
  x86_64|amd64)  KARCH=x64 ;;
  *) die "不支持的 CPU 架构: $(uname -m)" ;;
esac

CORES="$(nproc)"
THREADS="${THREADS:-$CORES}"
log "架构 $(uname -m) · $CORES 核 · 端口 $PORT · 线程 $THREADS · 安装到 $INSTALL_DIR"

# ---------------------------------------------------------------- 1. 依赖
log "1/7 安装系统依赖"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl git unzip ca-certificates cmake build-essential \
    libeigen3-dev zlib1g-dev libzip-dev libboost-filesystem-dev \
    libboost-program-options-dev libboost-system-dev libboost-thread-dev
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl git unzip cmake gcc-c++ eigen3-devel zlib-devel libzip-devel boost-devel
else
  die "只支持 apt(R) 或 dnf 系统"
fi

# ---------------------------------------------------------------- 2. Node.js
log "2/7 检查 Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [ "$major" -ge 18 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    dnf install -y nodejs
  fi
fi
log "Node.js $(node -v) · npm $(npm -v)"

mkdir -p "$INSTALL_DIR/katago" "$INSTALL_DIR/model" "$INSTALL_DIR/web"

# ---------------------------------------------------------------- 3. KataGo
log "3/7 准备 KataGo 引擎（$KARCH）"
KATAGO_BIN="$INSTALL_DIR/katago/katago"
if [ -x "$KATAGO_BIN" ]; then
  echo "    已存在，跳过"
else
  got=0

  # (a) 发行版仓库里如果有现成包，最省事
  if command -v apt-get >/dev/null 2>&1 && apt-cache show katago >/dev/null 2>&1; then
    echo "    尝试 apt 安装 katago"
    if apt-get install -y katago; then
      found="$(command -v katago || true)"
      [ -n "$found" ] && cp "$found" "$KATAGO_BIN" && got=1
    fi
  fi

  # (b) 官方预编译包
  if [ "$got" -eq 0 ]; then
    for suffix in "eigen-linux-$KARCH" "openblas-linux-$KARCH" "eigen-linux-$KARCH.tar.gz"; do
      url="https://github.com/lightvector/KataGo/releases/download/$KATAGO_VERSION/katago-$KATAGO_VERSION-$suffix.zip"
      echo "    尝试下载 $url"
      if curl -fL --retry 2 -o /tmp/katago.zip "$url" 2>/dev/null; then
        rm -rf /tmp/katago-unzip && mkdir -p /tmp/katago-unzip
        unzip -q -o /tmp/katago.zip -d /tmp/katago-unzip
        bin="$(find /tmp/katago-unzip -type f -name katago -perm -u+x | head -1)"
        if [ -n "$bin" ]; then
          cp "$bin" "$KATAGO_BIN"; chmod +x "$KATAGO_BIN"
          cfg="$(find /tmp/katago-unzip -type f -name '*.cfg' | head -1)"
          [ -n "$cfg" ] && cp "$cfg" "$INSTALL_DIR/katago/default_gtp.cfg"
          got=1; break
        fi
      fi
    done
  fi

  # (c) 源码编译（最保险；2 核 ARM 约 15~30 分钟）
  if [ "$got" -eq 0 ]; then
    warn "没有现成二进制，改为从源码编译（会比较久，请耐心等）"
    tmp="$(mktemp -d)"
    git clone --depth 1 https://github.com/lightvector/KataGo.git "$tmp/KataGo"
    cmake -S "$tmp/KataGo/cpp" -B "$tmp/KataGo/cpp/build" \
      -DUSE_BACKEND=EIGEN -DCMAKE_BUILD_TYPE=Release
    cmake --build "$tmp/KataGo/cpp/build" -j"$CORES"
    cp "$tmp/KataGo/cpp/build/katago" "$KATAGO_BIN"; chmod +x "$KATAGO_BIN"
    cp "$tmp/KataGo/cpp/configs/gtp_example.cfg" "$INSTALL_DIR/katago/default_gtp.cfg"
    rm -rf "$tmp"
    got=1
  fi

  [ "$got" -eq 1 ] || die "KataGo 安装失败"
fi
[ -f "$INSTALL_DIR/katago/default_gtp.cfg" ] || \
  curl -fsSL -o "$INSTALL_DIR/katago/default_gtp.cfg" \
    "https://raw.githubusercontent.com/lightvector/KataGo/master/cpp/configs/gtp_example.cfg" || true
echo "    引擎: $("$KATAGO_BIN" version 2>&1 | head -1)"

# ---------------------------------------------------------------- 4. 模型
log "4/7 准备神经网络模型"
MODEL="$INSTALL_DIR/model/model.txt.gz"
if [ -f "$MODEL" ] && [ "$(stat -c%s "$MODEL" 2>/dev/null || echo 0)" -gt 100000 ]; then
  echo "    已存在，跳过"
else
  # 脚本旁边就带着模型（仓库里的 deploy/model.txt.gz）
  if [ -f "$SCRIPT_DIR/model.txt.gz" ]; then
    cp "$SCRIPT_DIR/model.txt.gz" "$MODEL"
    echo "    使用随包模型"
  else
    echo "    从 KataGo 官方下载 b6c96 小网络"
    curl -fL --retry 2 -o "$MODEL" \
      "https://github.com/lightvector/KataGo/releases/download/v1.4.5/g170-b6c96-s175395328-d26788732.bin.gz" \
      || die "模型下载失败，请手动把 model.txt.gz 放到 $INSTALL_DIR/model/"
  fi
fi
echo "    模型: $MODEL ($(du -h "$MODEL" | cut -f1))"

# ---------------------------------------------------------------- 5. 网页服务
log "5/7 部署网页桥接服务"
if [ -f "$SCRIPT_DIR/../server.js" ]; then
  echo "    使用脚本所在仓库的文件"
  cp "$SCRIPT_DIR/../server.js" "$INSTALL_DIR/web/server.js"
  rm -rf "$INSTALL_DIR/web/public"
  cp -r "$SCRIPT_DIR/../public" "$INSTALL_DIR/web/public"
else
  echo "    从 GitHub 拉取"
  tmp="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$tmp/repo"
  cp "$tmp/repo/server.js" "$INSTALL_DIR/web/server.js"
  rm -rf "$INSTALL_DIR/web/public"
  cp -r "$tmp/repo/public" "$INSTALL_DIR/web/public"
  rm -rf "$tmp"
fi

TOKEN="${TOKEN:-$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)}"
cat > "$INSTALL_DIR/web/engine.json" <<JSON
{
  "port": $PORT,
  "host": "0.0.0.0",
  "token": "$TOKEN",
  "katago": "$KATAGO_BIN",
  "model": "$MODEL",
  "config": "$INSTALL_DIR/katago/default_gtp.cfg",
  "numSearchThreads": $THREADS,
  "startupTimeoutMs": 180000
}
JSON
echo "    配置: $INSTALL_DIR/web/engine.json"

# ---------------------------------------------------------------- 6. 系统服务
log "6/7 注册开机自启服务"
cat > /etc/systemd/system/go-katago.service <<UNIT
[Unit]
Description=Go KataGo Web Bridge (browser UI + GTP engine)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/web
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=5
Environment=GO_NO_OPEN=1

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable go-katago >/dev/null 2>&1 || true
systemctl restart go-katago
sleep 6

# ---------------------------------------------------------------- 7. 防火墙
log "7/7 放行端口 $PORT"
# 实例内部防火墙（Oracle 的 Ubuntu 镜像默认有 iptables 规则，必须放行）
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
    iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || true
  if [ -d /etc/iptables ]; then
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  fi
fi
if systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 验证
PUBIP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 ifconfig.me 2>/dev/null || echo '<公网IP>')"
STATUS="$(curl -fsS --max-time 8 "http://127.0.0.1:$PORT/api/status" 2>/dev/null | head -c 200 || echo '（还没起来，稍等再看）')"

cat <<DONE

================================================================
  部署完成
================================================================
  访问地址 : http://$PUBIP:$PORT/
  访问令牌 : $TOKEN
  引擎状态 : $STATUS

  ⚠️ 如果打不开，去 Oracle 控制台放行端口：
     实例 → 子网 → 安全列表(Security List) → 添加入站规则
     源 0.0.0.0/0，协议 TCP，目标端口 $PORT

  常用命令：
     systemctl status go-katago     查看状态
     journalctl -u go-katago -f     看日志
     systemctl restart go-katago    重启
================================================================
DONE
