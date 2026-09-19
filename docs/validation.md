# 交付验证记录

本地环境：Windows、Python 3.10.11。依赖版本见 requirements.lock。

| 检查 | 结果 |
|---|---|
| Python 自动化测试 | 30 项通过 |
| JavaScript 语法检查 | 通过 |
| 回放请求乱序回归 | 通过；旧响应不能覆盖新设备历史 |
| Chrome 真实浏览器流程 | 通过；实时连接、故障、确认、恢复、回放、定位、CSV、离线、手机布局、停止 |
| 浏览器 JavaScript 异常 | 0 |
| 独立代码审查 | 三项可复现问题已修复，复审未发现剩余实质问题 |
| SQLite 基准 | 三轮 10,000 条写入及全量重传，结果见 benchmark-results.json |

测试输出有两条来自 Starlette/AnyIO 的上游弃用提示，不是测试失败；当前固定版本仍能运行。后续升级 TestClient/httpx2 时需要重新验证。

当前没有执行实物传感器联调、持续运行压力测试、Docker 构建或多租户权限验证。GitHub Actions 的实际状态以仓库远端运行记录为准。
