# PTA Auto Solve

PTA 平台自动答题 Tampermonkey 脚本，支持多种题型 AI 自动解答。

## 功能

- **编程题**：支持 C/C++/Java/Python/Go/Rust 等多种语言
- **选择题**：单选、多选自动识别
- **填空题**：自动填写答案
- **SQL 题**：自动生成 SQL 语句
- **自定义题型**：手动指定题目类型和语言

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击 [安装脚本](https://github.com/hb-degithub/pta-/raw/main/pta-auto-solve.js) 或手动复制 `pta-auto-solve.js` 内容新建用户脚本
3. 打开 [PTA 平台](https://pintia.cn) 即可使用

## 使用

1. 进入题目页面后，脚本自动检测题目类型
2. 在悬浮面板中选择编程语言（编程题）
3. 点击「解答」获取 AI 答案
4. 答案自动填入编辑器，或显示在结果区域手动复制
5. 提交报错后可输入错误信息点击「自动修正」

## 配置

点击悬浮面板上的「设置」按钮：

- **API URL**：AI 服务地址（支持 DeepSeek 等自动补全）
- **API Token**：你的 API 密钥
- **模型名称**：如 `deepseek-chat`

## 特性

- 绕过 PTA 粘贴限制（CodeMirror 6 编辑器直连）
- 支持多种 AI API 格式
- 结果独立显示区域，支持复制/填入/自动修正
- 自定义请求参数（JSON 格式）

## 更新日志

### v3.4
- 题目类型和语言选择移至主面板
- API URL 和模型自动匹配
- 优化等待时间和响应处理
- 修复语言选择不生效问题
