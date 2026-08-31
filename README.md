# Vanilla2Eagler Proxy

让原版 Java Edition 1.8.9 客户端通过本代理进入 EaglercraftX 服务器。

```
原版 Java 1.8.9 客户端
      │  TCP Minecraft 协议 (默认端口 25565)
      ▼
Vanilla2Eagler Proxy
      │  Eaglercraft WebSocket 协议 (v3/v4/v5)
      ▼
EaglercraftX Server (ws://host:port)
```

## 运行

```bash
npm install
npm start
```

启动后控制台会打印 WebUI 地址，浏览器打开该地址即可管理代理。默认不会自动启动代理，需要在 WebUI 中点击“启动代理”。

## 配置

所有配置在 `config.json`，WebUI 修改后会自动保存。常用字段：

- `eaglerServer.url`：EaglercraftX 服务器地址，例如 `wss://mc.example.com`
- `relay.url` / `relay.code`：共享世界中继地址和房间码
- `forceUsername`：强制用户名，`null` 表示使用原版客户端用户名
- `webui.port`：WebUI 端口（默认随机空闲端口）
- `webui.exitOnUiClose`：关闭 WebUI 页面后是否自动退出程序
- `mineskin.enabled`：启用 MineSkin 签名皮肤
- `debug`：调试日志

## 开源范围

- Node.js 代理部分开源，MIT License。
- WebUI 基于 [Furry-Xiyi/WinUIonWeb](https://github.com/Furry-Xiyi/WinUIonWeb) 开发。
- 运行需要将 WebUI 构建产物放入 `webui-dist/`，否则仅代理后端可用。
