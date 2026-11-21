# 五子棋 · fnOS

一个跑在飞牛 OS（fnOS）上的五子棋小游戏。基于 [fnos-app-starter](https://github.com/thirtyminus/fnos-app-starter) 的 web 应用骨架改造：前端是 iframe 里的纯 Canvas 页面，后端是一个通过 Unix Socket 提供服务的 Go 二进制。

## 功能

- 15×15 标准棋盘，执黑先行
- 三档 AI 难度（简单 / 普通 / 困难）
- 落子预览：按下显示半透明棋子与高亮圆环，按住可拖动修正，抬手落子
- 悔棋、重开、胜负判定与连线高亮
- 对局自动存档到 `localStorage`，关掉窗口再进来可继续
- 战绩记录（胜/负），通过网关注入的 `X-Trim-Userid` 区分用户，汇总全服战绩
- 响应式布局：手机竖屏单栏、手机横屏与桌面窗口双栏，深浅色跟随系统

## 目录结构

```
manifest              # 应用元信息（appname、入口、平台）
config/privilege      # 运行用户
cmd/                  # 安装 / 启动 / 停止 / 卸载的生命周期脚本
app/                  # 打包进 fpk 的内容（二进制 + 桌面图标）
  ui/                 # 桌面图标与入口配置
backend/              # Go 源码
  main.go             # Unix Socket 服务、静态资源、战绩接口
  web/                # 前端页面，通过 go:embed 打进二进制
```

## 本地开发

需要 Go 1.21+。

```bash
cd backend
go run .
# 打开 http://127.0.0.1:8787/app/gomoku
```

改了前端文件要重启进程，因为静态资源是 `go:embed` 编译进二进制的。

## 打包与安装

```bash
# 编译 Linux 二进制
cd backend
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o ../app/gomoku-server .

# 打包（未签名，仅限本地调试）
cd ..
fnpack build --nosign
```

把生成的 `gomoku.fpk` 拖进飞牛应用中心的「手动安装」，或者用命令行：

```bash
fnos-cli --profile home app install-fpk ./gomoku.fpk --volume-id 1 --dry-run --yes
fnos-cli --profile home app install-fpk ./gomoku.fpk --volume-id 1 --yes
```

覆盖升级会失败，需要先卸载再装。

## AI 说明

候选点按四个方向的 5 格窗口打分：先判断自己能否成五、对手能否成五（必须堵），再按窗口内的连子数累加权重。困难档额外多看一层——模拟自己落子后计算对手的最佳回应，取净收益最大的点。它不会漏掉冲四，但也没有长期布局能力，属于「够用」的水平。

## 注意

- 未签名的 fpk 只能自己安装调试，不要分发。
- 战绩数据落在应用包变量目录，卸载应用会一并删除。
