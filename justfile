# log-skimmer-web — 构建与验证链。
# just check = lint + typecheck + build + unit + e2e (全绿门禁)。

default: check

# 安装依赖 (幂等: lockfile 变更或 node_modules 缺失时才重装)
install:
    @if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then \
        npm ci --no-audit --no-fund; \
    else echo "deps up-to-date"; fi

lint: install
    npm run lint

fmt:
    npm run fmt

build: install
    npm run build

typecheck: build
    npm run typecheck

unit: install
    npm run unit

# e2e 前置 build (e2e 注入 dist/ 产物, 不 build 会测到旧产物)
e2e: build
    npm run e2e

# 本地静态服务 (fixture 页 + 产物; e2e 由 playwright webServer 自管, 此 recipe 供人工浏览)
serve: install
    npm run serve

# CWS 上架素材 (1280×800 截图 ×3 + 440×280 promo → docs/store/assets/, 入库工件)
store-shots: build
    LSK_STORE_SHOTS=1 npm run e2e -- e2e/store-shots.spec.ts

check: lint build typecheck unit e2e
    @echo "=== just check 全绿 ==="

# playwright 浏览器安装 (一次性; 已有 ~/.cache/ms-playwright 匹配版本则跳过)
browsers:
    npx playwright install chromium
