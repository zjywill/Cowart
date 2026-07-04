# Cowart

Cowart is a native infinite-canvas widget plugin for Codex. It brings a tldraw-powered canvas into Codex for visual thinking, annotation, image generation, and annotation-driven image edits. The canvas opens directly as an MCP widget, and its data is saved in the active user project under `canvas/` instead of inside the plugin repository.

中文说明: [README.md](README.md)

## Features

- Open a native tldraw infinite-canvas widget from Codex; normal use no longer opens a local page through a web browser or the in-app browser.
- Persist canvas pages and image assets in the active project directory.
- Create AI image slots on the canvas, enter a prompt directly, choose reference images, and let Codex generate an image that replaces the selected slot at the same position and aspect ratio.
- After annotating an image, submit the annotation screenshot directly from the canvas so Codex can generate a clean revised image beside the original.
- Use Cowart MCP tools to read selection state, save the canvas, insert images, and save page-local assets.

## Installation

### Ask Codex To Install It

Send the following message to Codex:

```text
Please install the Cowart Codex plugin from https://github.com/zhongerxin/cowart.git.
Clone the repository into ~/plugins/cowart, verify that .codex-plugin/plugin.json exists,
add the plugin to the personal marketplace, run codex plugin marketplace add ~,
then run codex plugin add cowart@personal.
After installing, validate the plugin and tell me whether I should start a new conversation to load the new skills and MCP tools.
```

### Manual Install

Clone the plugin into the default location referenced by the Codex personal marketplace:

```bash
mkdir -p ~/plugins
git clone https://github.com/zhongerxin/cowart.git ~/plugins/cowart
cd ~/plugins/cowart
npm install
npm run build
```

Make sure `~/.agents/plugins/marketplace.json` contains a Cowart entry:

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

Then register the personal marketplace and install the plugin:

```bash
codex plugin marketplace add ~
codex plugin add cowart@personal
```

After installing, start a new Codex conversation so the new skills and MCP tools are loaded cleanly.

## Usage

### Open The Canvas

Ask Codex:

```text
Open the Cowart canvas for this project.
```

Cowart opens a native Codex widget through `render_cowart_canvas_widget`; it no longer needs a localhost page or manual in-app-browser navigation. `scripts/start-canvas.sh` remains only as a local-development fallback.

Canvas data is saved in the active project:

```text
canvas/pages/<page-id>/cowart-canvas.json
canvas/pages/<page-id>/assets/
```

![Open Cowart canvas in Codex](assets/open-canvas.png)

### Generate A New Image

1. Open the Cowart canvas.
2. Create and select an `AI 图片` slot on the canvas.
3. In the generation panel, enter a prompt, optionally choose one or more reference images, then send the request.

Cowart sends the prompt, reference images, and selected `AI 图片` slot dimensions to Codex. Codex generates an image for that position and aspect ratio, then replaces the `AI 图片` slot with a normal image shape.

![Generate and insert a new image with Cowart](assets/generate-image.png)

### Generate From An Annotation Screenshot

1. Annotate an image on the Cowart canvas.
2. Select the annotated image and click `按标注修改`.
3. Cowart exports a screenshot containing the original image, arrows, and annotation text, then sends it to Codex through the widget bridge.

Codex reads the notes and arrows in the screenshot, generates a clean revised image without annotation artifacts, and places it beside the original. The original image and annotations are not deleted or moved. You can also manually send a Cowart annotation screenshot to Codex and use the same revision workflow.

![Generate a revised image from a Cowart annotation screenshot](assets/annotation-edit.png)

## Skills

- `cowart:cowart-open-canvas`: open the native Cowart canvas widget.
- `cowart:cowart-image-gen`: receive the canvas prompt and reference images, replace the selected `AI 图片` slot with a generated image, or insert a generated image into the current page when no slot is selected.
- `cowart:cowart-image-edit`: generate a revised image from a Cowart annotation screenshot submitted from the canvas or provided by the user.

## Local Development

```bash
npm install
npm run dev
npm run build
```

For local development, you can still start the Vite canvas service directly and pass the active user project directory:

```bash
./scripts/start-canvas.sh /path/to/user/project
```

Useful environment variables:

- `COWART_PORT`: local service port, default `43217`.
- `COWART_PROJECT_DIR`: the user project directory that owns the canvas data.
- `COWART_CANVAS_DIR`: canvas data directory, default `$COWART_PROJECT_DIR/canvas`.

## Developer

ZHONG XIN  
zhongxin123456@gmail.com  
https://www.jiqiren.ai

## Acknowledgments

Cowart's canvas experience is built on top of [tldraw/tldraw](https://github.com/tldraw/tldraw).
