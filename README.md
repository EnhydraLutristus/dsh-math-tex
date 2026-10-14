# dsh-math-tex — 让 DSH 的数学回答不再变成一片红字

这个仓库有两部分：**一个问题**（DSH 渲染数学时把源码红字吐到屏幕上）和**一个插件**（在文本落盘之前把这个问题拦掉）。`math-typeset/` 是同一时期另一件数学核对工作的完整记录，一并保留。

---

## 问题是什么

在 DSH 里贴一段较长的推导，屏幕有时会变成一大片红色 LaTeX 源码。没有崩溃、没有日志、没有报错——只是**渲染器拒绝了这段数学，转而把原始源码画了出来**。

追下去发现三件事：

1. **不是崩溃。** 宿主崩溃日志里只有 `STATUS_CONTROL_C_EXIT`（正常退出），没有任何渲染进程故障。红字是**设计好的降级路径**。
2. **判据不是"有没有抛异常"。** 渲染链是三段：严格调用 → 宽松调用 → 红色 span 兜底。实测宽松段并不"静默画错"，它同样用错误色 `#cc0000` 把错误画出来；更麻烦的是 `\htmlClass{red}{x}` 这类被禁用的扩展命令**严格调用是成功的**，输出里仍然带错误色。只看异常的实现会把这块判成健康。
3. **前端改不了。** KaTeX 内联在 `app.asar` 内的一个整体 bundle 里，渲染器不传任何 KaTeX 选项（没有 `errorColor`、没有 `maxExpand`、没有 `trust`），客户端所有 slot 里也没有一个与数学相关。所以修复必须发生在**文本落盘之前**——那是唯一能同时影响屏幕、会话记录和上下文压缩的位置。

## 插件做了什么

`plugin-design/dsh-math-tex/` 是一个 host 侧 DSH 插件（无客户端部分），装两道防线：

| | 机制 | 作用 |
| --- | --- | --- |
| 预防 | `systemPrompt.section` | 注入排版规则：行间公式单独成段、一个 `$$` 块只放一个公式、块内不得有标题或正文、标题不得与公式同行 |
| 兜底 | `llm/stream` waterfall | 用**客户端同版本 KaTeX** 判定每个数学区域，修掉会被渲染成红色的那些 |

修复只做两种有确定语义的改动（去掉渲染器不认识的命令的反斜杠、给重复算子重新分组），改完必须重新渲染验证"严格通过且无红色"才接受；结构性损坏降级成带围栏的源码块。**数学永不删除，修复永不编造。**

```powershell
cd plugin-design/dsh-math-tex
npm test                     # 8 个测试文件，517 条断言
node ../../install.mjs       # 装进 desktop profile 并登记为 bundle
```

细节见 [plugin-design/dsh-math-tex/README.md](plugin-design/dsh-math-tex/README.md)，设计取舍见 [plugin-design/DESIGN.md](plugin-design/DESIGN.md)，当前状态与"还没证明什么"见 [plugin-design/STATUS.md](plugin-design/STATUS.md)。

## 仓库结构

```
plugin-design/
  dsh-math-tex/        插件本体：lib/ + test/ + 文档 + 清单
  STATUS.md            交接状态：装了什么、证明了什么、还差什么、踩过哪些坑
  DESIGN.md            设计：为什么在 host 侧、为什么用渲染产物做判据
  FINDINGS.md          证据链：渲染器实现、客户端服务目录、故障分类
  install.mjs          安装器（复制 payload + 登记 bundle，幂等，带备份）
math-typeset/
  demo-wave.tex/.pdf   波动方程解析解与差分格式的核对报告
  verify_wave.py       符号核对脚本
  fig-*.png            对比图
```

## 已知边界

- 渲染器不可修改，这是设计前提，不是待办事项。
- 仅 host 侧：唯一的拦截点是 `llm/stream`。
- 打开但未闭合的 `$$` 会吞掉后续正文——那是 Markdown 解析行为，不属于可修复的公式区域。
- 真实会话里的钩子调用证据需要一次现场运行：`node plugin-design/dsh-math-tex/tools/verify-live.mjs`（STATUS.md §5 说明了判据）。
