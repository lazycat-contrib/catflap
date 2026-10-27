# Catflap

管理 LightOS 实例与 MicroVM，连接终端、远程桌面和实例内的编程代理。

## 功能

- 查看实例状态，创建、启动、停止和重启实例；只允许销毁自己在 Catflap 中创建并确认归属的实例。
- 创建任务单独显示进度与报告；移除报告不会删除实例或文件。
- 使用已注册的 WebShell 打开终端，连接实例或物理设备中可用的远程桌面服务。
- 在实例中使用编程代理，处理会话、Skill、审批、队列与定时任务。
- 管理 MicroVM，按运行环境实际能力提供初始化和终端入口。

## 安装与更新

在喵喵商店搜索 **Catflap**，或从 [GitHub Releases](https://github.com/lazycat-contrib/catflap/releases/latest) 下载 `.lpk`，通过懒猫应用安装入口安装。

每个版本同时提供 `checksums.txt`，可核对下载文件的 SHA256。安装包标识为 `community.lazycat.app.catflap`。

## 系统要求

- 懒猫系统 1.5.2 或更新版本，amd64 架构。
- LightOS 与设备访问按当前用户的平台授权开放。
- MicroVM 需要设备支持 KVM；终端需要已注册的 WebShell，远程桌面需要目标设备有可用的服务和认证信息。

创建报告不是实例的运行状态，超时或断连也不代表操作成功。更新不会自动替你启停或销毁实例。
