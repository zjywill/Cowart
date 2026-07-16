import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./scripts/start-mcp.mjs"],
});

const client = new Client({
  name: "cowart-probe",
  version: "0.1.0",
});

await client.connect(transport);

let downloadedProbePath = null;
let downloadedProbeDirectory = null;
let probeProjectDir = null;

function isCanvasDirectory(value) {
  const canvasDir = String(value || "");
  return (
    path.basename(path.normalize(canvasDir)) === "canvas" ||
    path.win32.basename(path.win32.normalize(canvasDir)) === "canvas"
  );
}

try {
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  const requiredTools = [
    "render_cowart_canvas_widget",
    "get_cowart_canvas_state",
    "save_cowart_canvas_state",
    "save_cowart_selection_state",
    "save_cowart_view_state",
    "save_cowart_reference_image",
    "read_cowart_page_asset",
    "download_cowart_file",
    "get_cowart_selection",
    "insert_cowart_image",
    "draw_cowart_svg",
    "insert_cowart_html_draft",
  ];

  for (const toolName of requiredTools) {
    if (!toolNames.includes(toolName)) {
      throw new Error(`${toolName} not found. Tools: ${toolNames.join(", ")}`);
    }
  }

  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-widget-probe-"));
  probeProjectDir = projectDir;
  const renderResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {
      projectDir,
      title: "Probe Cowart",
    },
  });
  if (renderResult._meta?.["openai/outputTemplate"] !== "ui://widget/cowart/canvas.html") {
    throw new Error("Cowart render tool result did not include the expected outputTemplate.");
  }
  if (renderResult.structuredContent?.preferredDisplayMode !== "fullscreen") {
    throw new Error("Cowart render tool did not default to fullscreen display mode.");
  }
  if (renderResult.structuredContent?.projectDir !== projectDir) {
    throw new Error("Cowart render tool did not preserve the requested projectDir.");
  }

  const stateResult = await client.callTool({
    name: "get_cowart_canvas_state",
    arguments: {
      projectDir,
    },
  });
  if (stateResult.structuredContent?.storage !== "empty") {
    throw new Error("A fresh Cowart project should report empty storage.");
  }
  if (!isCanvasDirectory(stateResult.structuredContent?.canvasDir)) {
    throw new Error("Cowart canvas state did not report a project-local canvas directory.");
  }
  if ((stateResult.structuredContent?.hydratedAssets || []).length !== 0) {
    throw new Error("Cowart canvas state should not hydrate image assets by default.");
  }

  const probeSnapshot = {
    schema: {
      schemaVersion: 2,
      sequences: {
        "com.tldraw.store": 5,
        "com.tldraw.asset": 1,
        "com.tldraw.camera": 1,
        "com.tldraw.document": 2,
        "com.tldraw.instance": 26,
        "com.tldraw.instance_page_state": 5,
        "com.tldraw.page": 1,
        "com.tldraw.instance_presence": 6,
        "com.tldraw.pointer": 1,
        "com.tldraw.shape": 4,
        "com.tldraw.user": 1,
        "com.tldraw.asset.image": 6,
        "com.tldraw.asset.video": 5,
        "com.tldraw.asset.bookmark": 2,
        "com.tldraw.shape.arrow": 8,
        "com.tldraw.shape.bookmark": 2,
        "com.tldraw.shape.draw": 4,
        "com.tldraw.shape.embed": 4,
        "com.tldraw.shape.frame": 1,
        "com.tldraw.shape.geo": 11,
        "com.tldraw.shape.group": 0,
        "com.tldraw.shape.highlight": 3,
        "com.tldraw.shape.image": 5,
        "com.tldraw.shape.line": 5,
        "com.tldraw.shape.note": 12,
        "com.tldraw.shape.text": 4,
        "com.tldraw.shape.video": 4,
        "com.tldraw.binding.arrow": 1,
      },
    },
    store: {
      "document:document": {
        gridSize: 10,
        name: "",
        meta: {},
        id: "document:document",
        typeName: "document",
      },
      "page:page": {
        meta: {},
        id: "page:page",
        name: "Page 1",
        index: "a1",
        typeName: "page",
      },
    },
  };
  const saveStateResult = await client.callTool({
    name: "save_cowart_canvas_state",
    arguments: {
      projectDir,
      snapshot: probeSnapshot,
    },
  });
  if (saveStateResult.isError) {
    throw new Error(`Cowart probe snapshot failed to save: ${JSON.stringify(saveStateResult.content)}`);
  }

  const pigSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">',
    '<rect width="320" height="240" rx="24" fill="#fff7ed"/>',
    '<ellipse cx="160" cy="132" rx="90" ry="70" fill="#f9a8d4" stroke="#831843" stroke-width="6"/>',
    '<path d="M98 83 L78 40 L126 66 Z" fill="#f9a8d4" stroke="#831843" stroke-width="6" stroke-linejoin="round"/>',
    '<path d="M222 83 L242 40 L194 66 Z" fill="#f9a8d4" stroke="#831843" stroke-width="6" stroke-linejoin="round"/>',
    '<circle cx="128" cy="116" r="8" fill="#1f2937"/>',
    '<circle cx="192" cy="116" r="8" fill="#1f2937"/>',
    '<ellipse cx="160" cy="158" rx="42" ry="30" fill="#f472b6" stroke="#831843" stroke-width="5"/>',
    '<circle cx="145" cy="158" r="6" fill="#831843"/>',
    '<circle cx="175" cy="158" r="6" fill="#831843"/>',
    '<path d="M132 192 Q160 210 188 192" fill="none" stroke="#831843" stroke-width="5" stroke-linecap="round"/>',
    "</svg>",
  ].join("");
  const drawResult = await client.callTool({
    name: "draw_cowart_svg",
    arguments: {
      projectDir,
      pageId: "page:page",
      svgContent: pigSvg,
      fileName: "probe-pig.svg",
      altText: "A smiling pink pig",
    },
  });
  if (drawResult.isError) {
    throw new Error(`Cowart SVG draw failed: ${JSON.stringify(drawResult.content)}`);
  }
  const drawn = drawResult.structuredContent;
  if (
    !drawn?.shapeId ||
    !drawn?.assetId ||
    drawn.pageId !== "page:page" ||
    drawn.bounds?.w !== 320 ||
    drawn.bounds?.h !== 240
  ) {
    throw new Error(`Cowart SVG draw returned invalid handles or bounds: ${JSON.stringify(drawn)}`);
  }
  const drawContent = drawResult.content?.map((item) => item.text || "").join("\n") || "";
  if (!drawContent.includes(drawn.shapeId) || !drawContent.includes(drawn.assetFile)) {
    throw new Error("Cowart SVG draw content omitted the shape id or asset file handle.");
  }
  const savedPigSvg = await readFile(drawn.assetFile, "utf8");
  if (!savedPigSvg.includes("<ellipse") || !drawn.assetFile.endsWith("probe-pig.svg")) {
    throw new Error("Cowart SVG draw did not persist the expected page-local SVG asset.");
  }
  const drawnStateResult = await client.callTool({
    name: "get_cowart_canvas_state",
    arguments: {
      projectDir,
    },
  });
  const drawnStore = drawnStateResult.structuredContent?.snapshot?.store || {};
  const drawnShape = drawnStore[drawn.shapeId];
  const drawnAsset = drawnStore[drawn.assetId];
  if (
    drawnShape?.type !== "image" ||
    drawnShape.props?.assetId !== drawn.assetId ||
    drawnShape.meta?.cowartInlineSvg !== true ||
    drawnAsset?.props?.mimeType !== "image/svg+xml" ||
    drawnAsset?.meta?.cowartInlineSvg !== true
  ) {
    throw new Error("Cowart SVG draw did not persist matching tldraw image asset and shape records.");
  }
  const unsafeDrawResult = await client.callTool({
    name: "draw_cowart_svg",
    arguments: {
      projectDir,
      pageId: "page:page",
      svgContent:
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    },
  });
  const unsafeDrawMessage = unsafeDrawResult.content?.map((item) => item.text || "").join("\n") || "";
  if (!unsafeDrawResult.isError || !unsafeDrawMessage.includes("not allowed")) {
    throw new Error("Cowart SVG draw did not reject an unsafe script element.");
  }

  const probePageAssetDir = path.join(projectDir, "canvas", "pages", "probe-page", "assets");
  await mkdir(probePageAssetDir, { recursive: true });
  await writeFile(
    path.join(probePageAssetDir, "tiny.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  );
  await writeFile(path.join(probePageAssetDir, "draft.html"), "<!doctype html><html><body>draft</body></html>");
  const pageAssetResult = await client.callTool({
    name: "read_cowart_page_asset",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/tiny.png",
    },
  });
  if (pageAssetResult.structuredContent?.mimeType !== "image/png" || !pageAssetResult.structuredContent?.dataBase64) {
    throw new Error("Cowart page asset tool did not return the expected png payload.");
  }
  const htmlAssetResult = await client.callTool({
    name: "read_cowart_page_asset",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/draft.html",
    },
  });
  if (htmlAssetResult.structuredContent?.mimeType !== "text/html" || !htmlAssetResult.structuredContent?.dataBase64) {
    throw new Error("Cowart page asset tool did not return the expected html payload.");
  }

  const downloadResult = await client.callTool({
    name: "download_cowart_file",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/tiny.png",
      fileName: `cowart-download-probe-${process.pid}.png`,
    },
  });
  downloadedProbePath = downloadResult.structuredContent?.filePath;
  if (!downloadedProbePath || !(await readFile(downloadedProbePath)).length) {
    throw new Error("Cowart download tool did not write the expected file into Downloads.");
  }

  const folderDownloadResult = await client.callTool({
    name: "download_cowart_file",
    arguments: {
      projectDir,
      dataUrl: "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3Eprobe%3C%2Ftitle%3E",
      directoryName: `Cowart Slides Probe ${process.pid}`,
      subdirectory: "pages",
      fileName: "page-01.html",
      mimeType: "text/html",
      overwrite: true,
      uniqueDirectory: true,
    },
  });
  downloadedProbeDirectory = folderDownloadResult.structuredContent?.directoryPath;
  const folderDownloadPath = folderDownloadResult.structuredContent?.filePath;
  if (
    !downloadedProbeDirectory ||
    path.basename(path.dirname(folderDownloadPath || "")) !== "pages" ||
    !(await readFile(folderDownloadPath, "utf8")).includes("<title>probe</title>")
  ) {
    throw new Error("Cowart download tool did not create the expected Slides export folder structure.");
  }

  const resource = await client.readResource({
    uri: "ui://widget/cowart/canvas.html",
  });
  const resourceMeta = resource.contents?.[0]?._meta || {};
  const widgetCsp = resourceMeta["openai/widgetCSP"] || {};
  const resourceDomains = widgetCsp.resource_domains || [];
  if (!resourceDomains.includes("data:") || !resourceDomains.includes("blob:")) {
    throw new Error(`Cowart widget CSP should allow local data/blob resources. Found: ${resourceDomains.join(", ")}`);
  }
  const frameDomains = widgetCsp.frame_domains || [];
  if (!frameDomains.includes("data:") || !frameDomains.includes("blob:")) {
    throw new Error(`Cowart widget CSP should allow local data/blob iframes for HTML drafts. Found: ${frameDomains.join(", ")}`);
  }

  const widgetHtml = resource.contents?.[0]?.text || "";
  if (!widgetHtml.includes("window.cowartMcp") || !widgetHtml.includes("Cowart Canvas")) {
    throw new Error("Cowart widget HTML does not include the expected bridge and app shell.");
  }
  if (/<script\b[^>]*\btype="module"/i.test(widgetHtml)) {
    throw new Error("Cowart widget HTML should use classic inline scripts for host compatibility.");
  }
  const shellMarkup = widgetHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  if (/<iframe\b/i.test(shellMarkup) || /<script\b[^>]+\bsrc=/i.test(shellMarkup) || /<link\b[^>]+\bhref=/i.test(shellMarkup)) {
    throw new Error("Cowart widget HTML should be direct static markup without iframe or external asset tags.");
  }

  console.log("OK: Cowart MCP tools and native widget resource are available.");
} finally {
  if (downloadedProbePath) {
    await unlink(downloadedProbePath).catch(() => undefined);
  }
  if (downloadedProbeDirectory) {
    await rm(downloadedProbeDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (probeProjectDir) {
    await rm(probeProjectDir, { recursive: true, force: true }).catch(() => undefined);
  }
  await client.close();
}
