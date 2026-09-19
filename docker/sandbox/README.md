# Sandbox image

该镜像提供非 root 的最小工作环境。P3 `DockerSandboxManager` 会创建一次性容器、复制本地仓库或在显式开放网络时 clone 远程仓库，设置 CPU/内存/Swap/PID 上限，默认关闭网络，并在成功、失败、超时或取消后回收容器。

文件 API 和命令 `cwd` 会同时校验词法路径与容器内真实路径，拒绝 path traversal 和 symlink escape。环境变量、stdin、输出与执行时间均有上限；命令参数保持结构化传递，不通过宿主机 shell 执行。

这仍不是面向不可信租户的完整安全边界。只读根文件系统、seccomp/AppArmor、自定义网络白名单、凭据代理和独立宿主机/微虚拟机隔离属于后续生产强化项。

`docker/compose.yml` 中的 PostgreSQL/Redis 是平台开发基础设施；每个 Run 的一次性 Sandbox container 不应加入该 Compose 生命周期。
