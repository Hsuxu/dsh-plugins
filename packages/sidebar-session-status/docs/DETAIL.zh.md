# 侧栏会话状态配色

这个 bundle 让侧栏会话列表更容易扫读，包含两个互相独立的能力：

1. **活动项目置顶。** 把主视图正在显示的会话所属的 Workspace 组移动到 Host 持久化的 Workspace 顺序首位。
2. **按状态给会话行着色。** 每个会话行增加一个状态小圆点和 2px 左侧状态条，四种状态四种颜色。

两者都只用公开扩展点：`sidebar.session.row.trailing` 与 `shell.overlay` 槽位、官方标记
`data-sidebar-list-area` / `data-row-key="session:<id>"`、`workspace/insertBefore`
命令，以及一个 summary 类型的会话投影。

## 状态映射

| 状态 | 颜色（主题 token） | 判定依据 |
| --- | --- | --- |
| 活动 | 蓝 — `--dsw-alias-trajectory-accent` | `SessionStatus.running`（回退到 `SessionSummary.running`） |
| 待审核 | 琥珀 — `--dsw-alias-state-warn-primary` | `SessionStatus.pendingInteraction`（等待审批、计划评审或回答） |
| 已中断 | 橙 — `#e2811c`（主题调色板没有橙色 token，用插件自有色） | 该会话最后一次 `turn/end` 的 `reason.kind` 为 `interrupted` 或 `aborted` |
| 失败 | 红 — `--dsw-alias-state-error-primary` | 该会话最后一次 `turn/end` 的 `reason.kind === 'error'` |
| 已完成 | 绿 — `--dsw-alias-state-success-primary` | `SessionStatus.completionUnread`：在别的视图获得焦点时运行结束、尚未查看 |
| 空闲 / 已归档 | 无 | 不渲染圆点、不着色 |

优先级为 `待审核` → `活动` → `失败` → `已中断` → `已完成` → `空闲`。已归档行保留官方灰化样式；
空白会话行（还没有首条提示）保持原样。

### 为什么需要 Host 投影

客户端 `SessionStatus` 只有 `running`、`pendingInteraction`、`completionUnread`，
`SessionSummary` 也没有失败字段。因此本 bundle 的 Host 半部注册了
`sidebarSessionStatus` 会话投影：把 `turn/end` 折叠成 `{ outcome, turn }`，并通过
`projectionValues`（`wire.summary` 默认 `true`）下发到每个列表行。客户端读取
`projectionValues.sidebarSessionStatus.outcome`。

投影值随列表摘要下发，所以失败行可能在下一次列表更新时变红，而不是失败当帧。
只有 `error` 算失败；以 `interrupted`（Host 中断）或 `aborted`（用户取消）结束的轮次
显示橙色；`blocked`、`max-tokens`、`forked` 仍走普通空闲/已完成逻辑。

## 置顶行为

- 「活动 Workspace」= `sessionIds` 中包含被主视图持有（`retainedBy.mainView > 0`）的会话的那个 Workspace。
- 不属于任何 Workspace 的会话（未分组桶）不触发重排。
- 重排是正常的 Host 变更：重启后依然生效，并对同一 Host 的所有窗口可见，效果等同手动拖动分组。
- 主视图切换到另一个 Workspace 的会话后，该 Workspace 会在下一次渲染时移到首位。
- 重排需要目标 Workspace 上的 `workspace/insertBefore` 权限；没有权限时静默跳过，Host 拒绝命令时同样只是不生效。

## 权限

插件只有一种写操作：调用客户端 Workspace Controller 的
`ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)`，并由
`useWorkspaceAccess(workspaceId, 'workspace/insertBefore')` 门控。它只读会话与
Workspace 快照，不写它们，不打开或归档会话，也不访问文件系统。

## 限制

- 置顶跟随主视图里打开的会话；刚启动、主视图还没有会话时顺序保持不变。
- 失败状态的变色依赖下一次列表摘要；正在打开的会话可能只在对话区体现失败。
- 行着色依赖 CSS `:has()`；不支持 `:has()` 的浏览器内核仍会显示四色圆点，但不会给整行加状态条与底色。
- 插件不提供设置项，映射关系固定。

## 卸载

从 profile 里移除该 bundle（或在插件列表停用）即可。Host 投影随插件 fiber 注销，
客户端样式表、圆点槽位与 overlay 槽位通过 `ctx.effect` 的清理函数移除。
