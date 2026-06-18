# android-helper 开发计划

## 目标

在一个 Muxy 面板里列出已连接的 Android 设备,选中某个设备点「安装」按钮,
**先编译新包再安装到该设备**。

## 需求拆解

1. **列设备** — 显示已连接设备(型号 / serial / 状态)。
2. **安装** — 选中设备 → 编译新包 → 安装到该设备。
3. **文件浏览** — 选中设备后,在下方展示该设备文件系统,可逐级进目录。
   默认从 `/sdcard/` 开始(免 root 可浏览);用 `adb -s <serial> shell ls -1 -p -A`
   列目录,`-p` 末尾斜杠区分目录/文件。仅浏览(暂不下载/上传)。
4. **Logcat** — 设备行「Log」按钮 → 原生 modal 选档 → 开终端 tab 流式 `adb logcat`
   (长流式,同安装走终端 tab)。档位:
   - **This app only** — 从 gradle `applicationId` 读当前工程包名,
     `pidof` 解析进程后 `--pid` 过滤;未运行时打印提示。
   - 全部 / 仅错误 `*:E` / 崩溃缓冲 `-b crash`。
   包名探测:启动时 `grep applicationId build.gradle{,.kts}`,读不到则隐藏该档。

## 能力映射

| 能力 | 用什么 | 权限 |
|---|---|---|
| 列设备 | `muxy.exec(['adb','devices','-l'])` 解析输出 | `commands:exec` |
| 编译+安装 | 开一个**终端 tab** 跑构建命令 | `tabs:write`(命令首次运行一次性确认) |
| 面板 UI | 复用现有 `panel/` | `panels:write`(已声明) |

## 架构决策

**编译不在 panel JS 里跑,而是 `muxy.tabs.open` 开一个终端 tab 执行
`gradlew installDebug`。** 理由:

1. 编译耗时长(几十秒~几分钟)。skill 警告:不要把持久工作放进 webview JS,
   关掉 panel 就丢了。终端 tab 是独立 tab,关 panel 不影响。
2. 终端 tab 天然流式显示构建日志,不用自己做进度/输出转发
   (`extension.*` 事件有 64 KiB 上限且不支持流式)。
3. 最原生,等同用户平时手敲 gradle。

`installDebug` 任务本身就是「先编译再安装」一步到位;用 `ANDROID_SERIAL=<serial>`
指定目标设备。

### 架构 A(推荐):纯 Panel,无 background.js

```
Panel (webview)
  ├─ 刷新按钮(header)
  └─ 设备行 × N: [型号] [serial] [状态点] [安装按钮]
       刷新   → muxy.exec(['adb','devices','-l']) → 解析 → 重渲染
       [安装] → muxy.tabs.open({kind:'terminal',
                  directory:<工程根>,
                  command:'ANDROID_SERIAL=<serial> ./gradlew installDebug'})
```

- 列设备:panel 启动 + 点刷新时跑 `adb devices -l`,解析每行
  `serial / state / model:`,渲染成行;非 `device` 状态(offline/unauthorized)
  的「安装」按钮禁用。
- 安装:点按钮开终端跑 `installDebug`,用户在终端看编译+安装全过程。

**待验证点**:`muxy.exec` 在 panel webview 里是否可用(文档确认 background/runScript
可用,webview 会弹一次运行时确认)。实现第一步即验证;若不可用 → 退架构 B。

### 架构 B(备选,A 不成立时):Panel + 瘦 background.js

- `background.js`:跑 `adb devices -l` 推给 panel;订阅
  `extension.android-helper:install`,收到后 `muxy.tabs.open` 开终端构建。
- panel:订阅设备事件渲染;点安装 `emit(...install,{serial})`。
- 注意:webview 发 `extension.*` 事件要求 background 在运行,故 manifest 必须声明
  `background`。

## 文件改动清单(已全部完成 ✅)

1. **`package.json` 的 `muxy` 段** ✅
   - `permissions`: `["panels:write","commands:exec","tabs:write"]`
   - starter 的 `hello` 资源已重命名为 android 语义(panel id `devices`、
     topbar/命令 `toggle-devices`/`refresh-devices`、快捷键 `cmd+shift+a`、图标 `iphone`)。
2. **`vite.config.js`** ✅ — rollup input `hello` → `devices`。
3. **`panel/index.html`** ✅ — title `Android Devices`。
4. **`src/main.js`** ✅ — 挂载 `DeviceListPanel`。
5. **`src/lib/adb.js`(新增)** ✅ — 纯函数,已 node 测试:
   - `parseDevices()` 解析 `adb devices -l`
   - `buildInstallCommand()` 拼 `ANDROID_SERIAL=… ./gradlew installDebug`
   - `deviceLsCommand()` / `parseLsEntries()` / `joinDir()` / `parentPath()` 文件浏览
   - `logcatCommand()`(all/error/crash/app)/ `parseApplicationId()` 日志
6. **`src/lib/icons.js`** ✅ — smartphone / download / alert / folder / file / arrowUp / logs。
7. **`src/panel/app.js`** ✅ — `DeviceListPanel`:列设备、选中、安装、文件浏览、logcat。
8. (架构 B 备选,未采用)**`background.js`**。

## UI 规范(muxy-extension skill)

- 颜色全用 `var(--muxy-…)`,不写死 hex。
- 行高 ~34px、左右内距 10px、正文 12px、图标 12–14px weight 600、
  按钮 28px 高 / 圆角 6。
- 主操作用 `--muxy-accent`;在线状态点 `--muxy-diff-add`(绿),
  异常 `--muxy-diff-remove`。
- 当前 `app.js` 用 Tailwind 类名(`bg-primary` 等),`global.css` 已把这些映射到
  `--muxy-*`;主题切换应正常,实现时确认。

## 实施步骤

- [x] 1. 验证环境:`adb` 在 PATH(`/opt/homebrew/bin/adb`)。工程根 `./gradlew` /
       `installDebug` 由用户的 Android 工程提供。
- [x] 2. 改 manifest 权限 + 重命名 starter 资源。
- [x] 3. 写 `src/lib/adb.js` 纯函数(全部 node 测试通过)。
- [x] 4. panel:列设备 / 选中 / 安装。`npm run build` 通过。
- [x] 5. panel:文件浏览器(选中设备后下方展开,逐级进目录)。
- [x] 6. panel:logcat(Log 按钮 + 原生 modal 四档,含 This app only)。
- [ ] 7. **Muxy 内实测**:Reload / Load Unpacked 指向本目录 → 列设备 → 装一次 →
       浏览 `/sdcard/` → 看日志。**这步会验证唯一运行时假设:`muxy.exec` 在 panel 可用**;
       若不可用 → 切架构 B(加瘦 `background.js`)。
- [x] 8a.✅ **装完自动启动 App + 跟踪日志** — `installAndLogCommand()` 链式执行:
       `./gradlew install` → `adb shell monkey -p <pkg> 1` → `adb logcat <pkg>:V *:S`,
       终端逐步显示编译、启动确认、日志流。无包名时退化到纯安装。
- [x] 8b.✅ **构建变体选择器** — Install 按键弹出 modal 可选 build type + module,
       单变体时自动跳过 modal 一键安装。
- [x] 8c.✅ **`applicationIdSuffix` 解析** — 自动读 gradle `applicationIdSuffix`,
       "This app only" logcat 使用有效包名(含后缀)。

## 当前状态

代码层面全部完成,`npm run build` 通过,纯函数均已 node 测试。
**唯一未验证项**:在 Muxy 真实环境里 `muxy.exec` / `muxy.tabs.open` / `muxy.modal`
能否在 panel webview 调用(文档未明确,webview 首次会弹运行时确认)。需在 Muxy 内
Reload 实测;若 exec 在 panel 不可用,按架构 B 加 `background.js` 顶上。

## 待确认假设(实现时采用的默认值)

1. **构建工具 = Gradle**,任务 `installDebug`(编译+装一步),变体 debug。
   → 如需指定 module(`:app`)/release/自定义任务,改 `buildInstallCommand`。
2. **Android 工程根 = Muxy 打开的 workspace 根**(`exec`/`tabs.open` 默认 cwd)。
3. 安装后**只装不启动**(未自动 launch)。
4. **包名静态读 gradle `applicationId`**;变量动态拼或 debug 后缀场景见步骤 8 待办。

---

## 建议功能(待排期)

### ⭐ P0 — 下一轮

**① 一键截图** 📷
- 设备行加 📷 按钮 → `adb exec-out screencap -p` 截图
- 自动 `pull` 到 `~/Downloads/android-screenshots/` + 终端显示保存路径

**② 无线连接** 🔗
- 面板加输入框:输入 `IP:端口` → `adb connect`
- 扫码或局域网调试,方便不用 USB 线

### 👍 P1 — 值得做

**③ 设备信息弹窗** ℹ️
- 点击设备行头部 → 显示 `adb shell getprop` 提取的信息
- Android 版本、DPI、CPU 架构、电池状态、IP 地址

**④ ADB Shell 快捷输入** 💻
- 底栏小输入框,对选中设备直接执行 `adb shell <命令>`

**⑤ Logcat 增强** 🔍
- 缓冲区选择(main/system/crash)、关键词高亮/过滤

### 🟢 P2 — 低优先级

**⑥ 强制停止 / 清除数据** 🛑
- Install 旁加操作菜单:`adb shell am force-stop <pkg>` / `adb shell pm clear <pkg>`
