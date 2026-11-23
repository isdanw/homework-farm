# P3 · iPad 原生 App 技术设计（试卷端）

> 版本：v1.0｜日期：2026-10-21
> 承接《自助导学 · 试卷系统功能设计》第五节开发计划 P3：**iPad 原生 App：绑定 + 试卷中心 + PencilKit 书写 + 批改**
> 前置：P0–P2 已完成（`examService` 云函数 + 小程序闭环已上线）

---

## 一、目标与边界

### 本期（P3）交付
1. **试卷中心**：列出本账号的试卷（AI 生成 / 自建），区分「未作答 / 已回收（已提交批改）」，可下拉刷新。
2. **AI 生成测验**：选学科 / 题量 / 难度 / 卷型 → 生成结构化试卷 → 直接进入作答。
3. **在线作答 + PencilKit 书写**：选择题点选、填空/计算/简答键盘输入、书写题用 Apple Pencil 手写（压感 + 防误触），可上传云存储。
4. **AI 批改报告**：总评（正确率/得分/薄弱点/建议）+ 逐题对错与错因诊断（E1–E9），错题自动回流。
5. **账号绑定（可选）**：输入小程序生成的令牌，把本机 iPad 账号与微信 openid 绑定，共享同一份试卷/错题数据。

### 本期不做
- Word/PDF 上传转可书写（P4）。
- 视觉模型密钥在 App 内配置（密钥属服务端安全配置；P3 只支持服务端已配置，App 侧选择路线）。
- 掌握度判定（严格遵守「活动≠证据≠掌握」，只给「达标/未达标」与错因）。

---

## 二、技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| UI 框架 | SwiftUI | 与题型组件化需求匹配；声明式便于维护 |
| 手写 | **PencilKit**（`PKCanvasView` 桥接） | Apple Pencil 压感、防 palm rejection、笔迹自然；系统原生无三方依赖 |
| 最低系统 | iPadOS 17.0 | SwiftUI `@Observable`、`NavigationStack`、`.scrollDismissesKeyboard` 等现代 API |
| 网络 | `URLSession` + `async/await` | 无三方依赖；云函数 URL 化后纯 HTTPS 即可 |
| 身份 | 本机生成稳定 `uid` → Keychain | 契合设计文档决策①「不强制绑定，独立账号可跑」 |
| 状态 | `@Observable`（Observation） | 轻量、无 Combine 负担 |
| 工程生成 | XcodeGen（`project.yml`） | `.xcodeproj` 为生成物，不进 git，团队/换机可复现 |

---

## 三、后端通道（**本设计最关键的一节，已实测打通**）

### 3.1 为什么走「云函数 URL 化」而不是 CloudBase iOS SDK
CloudBase 开放 API `POST /api/v2/envs/{envId}/functions/{name}:invoke` 需要 `X-CloudBase-Authorization` 头，**那是管理员密钥，绝不能进客户端二进制**。原生 App 若走官方 SDK 需要配置自定义登录密钥（要持有私钥签名），同样不适合放进 App。因此选择**云函数 URL 化**：一个公开 HTTPS 地址 + 客户端令牌，零密钥泄漏面。

### 3.2 通道契约（已 curl 实测通过）

```
POST https://workbuddy-d2gsgtfvmde5c9adf-1305268412.ap-shanghai.app.tcloudbase.com/examapi
Headers: Content-Type: application/json
         x-exam-token: <EXAM_HTTP_TOKEN>
Body:    { "action": "...", "uid": "ipad_xxx", ... }   // 与小程序完全同构
```

响应：函数返回的 JSON 原样作为 HTTP body（`{"ok":true,...}` / `{"ok":false,"code":"...","msg":"..."}`）。

### 3.3 云函数侧改动（P3 新增，已部署）
开启 URL 化后，云函数收到的 `event` 变为**集成请求**结构（`{path, httpMethod, headers, body:'JSON字符串', isBase64Encoded}`），而不是小程序那种原始 payload。为此在 `examService` 入口新增：

- `normalizeHttpEvent(raw)`：识别集成请求 → 解 base64 → `JSON.parse(body)` → 缺 `action` 时回退 `queryStringParameters`；非集成请求（小程序 SDK）**原样透传**。
- `httpTokenRejected(req)`：**仅对 URL 化入口生效**的令牌闸。设了环境变量 `EXAM_HTTP_TOKEN` 就校验 `x-exam-token`；没设则不拦（开发态）。小程序 SDK 路径永远不受此闸影响（走 wx 开放身份）。

> 归一化后，下方 `switch(action)` 一行未改 → **双端共用同一套业务代码**，不存在两套逻辑漂移。

### 3.4 安全边界（必须知情）
- URL 化地址是公开可打的。令牌闸可挡住随手滥用，但**令牌一旦进 App 二进制就可被提取**。
- 定位为**家庭自用**可接受；若要对外分发，需改为：开启 HTTP 访问服务鉴权（`tcb service auth switch`）+ 服务端签名校验，或改走网关。
- 数据仍按 `openid` 隔离：iPad 独立账号时 `openid = 'ipad_' + uid`，与微信 openid 不互通，除非执行绑定。

### 3.5 动作清单（App 用到的）
| action | 用途 | 需要身份 |
|---|---|---|
| `resolve` | 探测当前身份（绑定状态/命名空间），设置页「连接测试」 | 否 |
| `listExams` | 试卷中心列表 | 是 |
| `getExam` | 取单份试卷（含题目+参考答案，作答页） | 是 |
| `gen` | AI 生成测验 | 是（**消耗 AI Token**） |
| `grade` | 提交作答 → AI 批改 → 写提交记录 + 错题回流 | 是（**消耗 AI Token**） |
| `listSubmissions` | 「已回收」列表 | 是 |
| `getSubmission` | 二次查看某次批改报告 | 是 |
| `bind` | 用小程序生成的令牌绑定微信账号 | 是 |
| `listProviders` | 视觉模型 provider 列表（设置页展示） | 否 |

---

## 四、模块与文件结构

```
ipadApp/
├── project.yml                    XcodeGen 工程定义（唯一手写源）
├── .exam-token                    访问令牌（构建期注入 Info.plist，不进 git）
├── ExamPad/
│   ├── App/            ExamPadApp.swift, RootView.swift
│   ├── Core/
│   │   ├── Models.swift        Exam/Question/Submission/GradeResult 等 Codable
│   │   ├── APIClient.swift     URLSession + 令牌头 + 错误映射（可注入 URLSession 便于测试）
│   │   ├── ExamAPI.swift       端点封装的薄层（gen/grade/list...）
│   │   ├── Identity.swift      uid 生成/读取，Keychain 持久化
│   │   └── Settings.swift      端点/令牌覆盖、@Observable
│   ├── Features/
│   │   ├── Library/LibraryView.swift      试卷中心
│   │   ├── Library/GenerateSheet.swift    AI 生成表单
│   │   ├── Answer/AnswerView.swift        作答页
│   │   ├── Answer/QuestionCardView.swift  题型组件（choice/fill/calc/essay）
│   │   ├── Answer/PencilCanvas.swift      PencilKit 桥接 + 导出
│   │   ├── Report/ReportView.swift        批改报告
│   │   └── Settings/SettingsView.swift    身份/绑定/连接测试
│   └── Resources/Info.plist
└── ExamPadTests/        纯逻辑单测（模型解码、答案组装、API 契约、PencilKit 导出）
```

---

## 五、关键设计决策

### 5.1 身份：本地 uid + 可选绑定（对齐设计文档决策①）
- 首次启动生成 `uid`（如 `ipad_a1b2c3`）存 Keychain。
- 每次请求带 `uid`；云函数 `resolveOpenid` 无绑定时用 `ipad_<uid>` 作独立命名空间 → 数据独立可跑。
- 设置页可输入小程序端生成的 `bt_...` 令牌执行 `bind`；绑定后同一账号数据互通。
- **不做**强制登录、不采集任何个人信息（与小程序合规红线一致）。

### 5.2 PencilKit 导出与上传
- `PKCanvasView.drawing.image(from:scale:)` 导出位图 → PNG。
- 上传需走云存储 HTTP 接口。**本期策略**：手写题同时提供「文字答案」输入框（文字直接进 AI 批改，零配置可跑通）；手写图片走**可选上传**，未配置上传通道时如实提示「手写图片需配置上传通道或改用文字作答」，**不静默丢弃**。
- 与小程序一致：`draw` 题图片需要服务端已配置视觉模型，否则后端标记「需人工复核」并诚实降级。

### 5.3 作答页防丢失
- 作答状态保存在 `@Observable` 的 `AnswerDraft`，切题/切后台不丢。
- 顶部显示进度（第 i/N 题）与已作答数，未答完提交给出二次确认。

### 5.4 错误与降级（诚实原则）
后端所有失败都返回 `{ok:false, code, msg}`，App **原样展示 `msg`**，不吞错、不伪造成功。特别地：
- `no_pack`（AI 资源包未开通）→ 明确提示去控制台开通，而不是「生成失败」。
- `unauthorized` → 提示检查访问令牌（设置页一键粘贴）。
- `unanswered`/`not_found` → 区分「试卷不存在」与「暂不支持在线作答」。

---

## 六、验证方案（本机可完成的）

| 验证项 | 方法 | 状态 |
|---|---|---|
| 后端通道 | curl 直连 `/examapi`（含令牌闸正反例） | ✅ 已实测通过 |
| 云函数回归 | `EXAM_TEST=1 node scripts/test-exam-service.cjs`（52 项） | ✅ 已通过 |
| 工程可编译 | `xcodebuild -scheme ExamPad -destination 'platform=iOS Simulator'` 编译 | 待执行 |
| 纯逻辑单测 | `xcodebuild test`（模型解码/答案组装/API 契约/PencilKit 导出） | 待执行 |
| 真机 / TestFlight | 需 Apple Developer 账号 + 签名 | ⛔ 本机 `0 valid identities`，需用户侧准备 |

> **诚实话术**：本机无有效签名证书（`security find-identity -v -p codesigning` 返回 0 个），因此**无法产出真机包/TestFlight**。可交付到「模拟器可编译 + 单测通过 + 后端通道实测通」，真机验收需用户在 Xcode 登录其 Apple ID 后自行 Archive。

---

## 七、待用户确认事项

1. **App 名称与 Bundle ID**：建议 `自助导学·试卷` / `xyz.yiyo.exampad`（正式上架需唯一 ID）。
2. **是否需要 Apple Developer 账号**：如需 TestFlight/真机，需用户提供付费账号（免费账号仅够模拟器）。
3. **是否导出手写图片到云存储**：需要则追加云存储 HTTP 上传通道（一次性开发，后续 P4 复用）。