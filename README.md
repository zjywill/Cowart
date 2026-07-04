# Cowart

Cowart 是一个面向 Codex 的原生无限画布 widget 插件。它基于 tldraw 提供可视化画布，用于构思、标注、生成图片和根据标注图迭代图片。画布由 MCP widget 直接打开，数据默认保存到当前用户项目的 `canvas/` 目录，而不是保存到插件仓库里。

English README: [README.en.md](README.en.md)

## 功能

- 在 Codex 中打开一个原生 tldraw 无限画布 widget；正常使用不再通过网页浏览器或 in-app browser 打开本地页面。
- 在当前项目目录中持久化画布页面和图片资源。
- 在画布中创建 AI 图片框，直接输入 prompt、选择参考图，并让 Codex 按选中框的位置和比例生成图片后替换它。
- 标注好图片后，可从画布里直接提交标注截图，让 Codex 根据标注生成干净的新图并放到原图旁边。
- 通过 Cowart MCP 工具读取选择状态、保存画布、插入图片，并保存到页面本地资源目录。

## 安装

### 让 Codex 自动安装

把下面这段发给 Codex：

```text
请从 https://github.com/zhongerxin/cowart.git 安装 Cowart Codex 插件。
请 clone 仓库到 ~/plugins/cowart，确认 .codex-plugin/plugin.json 存在，
把插件加入 personal marketplace，先运行 codex plugin marketplace add ~，
再运行 codex plugin add cowart@personal。
安装后请校验插件，并告诉我是否需要开启一个新对话来加载新技能和 MCP 工具。
```

### 手动安装

推荐把插件 clone 到 Codex personal marketplace 默认会引用的位置：

```bash
mkdir -p ~/plugins
git clone https://github.com/zhongerxin/cowart.git ~/plugins/cowart
cd ~/plugins/cowart
npm install
npm run build
```

确保 `~/.agents/plugins/marketplace.json` 中有 Cowart 条目：

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "cowart",
      "source": {
        "source": "local",
        "path": "./plugins/cowart"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

然后先注册 personal marketplace，再安装插件：

```bash
codex plugin marketplace add ~
codex plugin add cowart@personal
```

安装后建议开启一个新的 Codex 对话，让新的 skill 和 MCP 工具完整加载。

## 使用

### 打开画布

在 Codex 中说：

```text
Open the Cowart canvas for this project.
```

Cowart 会通过 `render_cowart_canvas_widget` 打开 Codex 原生 widget，不需要再启动本地网页服务或手动打开 in-app browser。`scripts/start-canvas.sh` 只保留为本地开发 fallback。

画布数据会保存在当前项目目录下：

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
```

![在 Codex 中打开 Cowart 画布](assets/open-canvas.png)

### 生成新图

1. 打开 Cowart 画布。
2. 在画布里创建并选中一个 `AI 图片` 框。
3. 在弹出的生成面板里输入 prompt，也可以选择一张或多张参考图，然后点击发送。

Cowart 会把 prompt、参考图和选中 `AI 图片` 框的尺寸信息发送给 Codex。Codex 会按这个框的位置和比例生成图片，然后把 `AI 图片` 框替换成普通图片形状。

![使用 Cowart 生成并插入新图](assets/generate-image.png)

### 根据标注图生成新图

1. 在 Cowart 画布中对图片做标注。
2. 选中被标注的图片，点击 `按标注修改`。
3. Cowart 会导出包含原图、箭头和标注文字的截图，并通过 widget bridge 发送给 Codex。

Codex 会读取截图里的标注和箭头，生成去掉标注痕迹的新图，并把结果放在原图旁边。原图和标注不会被删除或移动。你也可以手动把 Cowart 标注截图发给 Codex，走同样的修订流程。

![根据 Cowart 标注截图生成修订图](assets/annotation-edit.png)

## 技能

- `cowart:cowart-open-canvas`：打开 Cowart 原生画布 widget。
- `cowart:cowart-image-gen`：接收画布内 prompt 和参考图，用生成图片替换选中的 `AI 图片` 框；没有选中框时也可以把生成图插入当前页面。
- `cowart:cowart-image-edit`：根据画布提交或用户提供的 Cowart 标注截图生成修订图。

## 本地开发

```bash
npm install
npm run dev
npm run build
```

本地开发时仍可以直接启动 Vite 画布服务，并指定用户项目目录：

```bash
./scripts/start-canvas.sh /path/to/user/project
```

常用环境变量：

- `COWART_PORT`：本地服务端口，默认 `43217`。
- `COWART_PROJECT_DIR`：画布数据所属的用户项目目录。
- `COWART_CANVAS_DIR`：画布数据目录，默认是 `$COWART_PROJECT_DIR/canvas`。

## 开发者

ZHONG XIN  
zhongxin123456@gmail.com  
https://www.jiqiren.ai

## 致谢

Cowart 的画布能力基于 [tldraw/tldraw](https://github.com/tldraw/tldraw) 实现。
