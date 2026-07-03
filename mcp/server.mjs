import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";

import {
  COWART_STATIC_BUILD_DIR,
  cowartStaticHtml,
} from "./lib/cowart-static-widget.mjs";
import {
  nonEmptyString,
  pageAssetUrl,
  pageDirName,
  pathResolve,
  readCowartCanvasState,
  readCowartSelectionState,
  readCowartViewState,
  resolveCanvasDir,
  resolveCowartPaths,
  saveCowartCanvasSnapshot,
  writeCowartSelectionState,
  writeCowartViewState,
} from "./lib/canvas-storage.mjs";
import { pluginPath } from "./lib/plugin-root.mjs";
import { inlineWidget, registerWidgetResource } from "./lib/widget-resource.mjs";

const TOOL_RENDER_WIDGET = "render_cowart_canvas_widget";
const TOOL_GET_CANVAS_STATE = "get_cowart_canvas_state";
const TOOL_SAVE_CANVAS_STATE = "save_cowart_canvas_state";
const TOOL_SAVE_SELECTION_STATE = "save_cowart_selection_state";
const TOOL_SAVE_VIEW_STATE = "save_cowart_view_state";
const TOOL_GET_SELECTION = "get_cowart_selection";
const TOOL_INSERT_IMAGE = "insert_cowart_image";

const PAGE_ID_PREFIX = "page:";
const COWART_WIDGET_URI = "ui://widget/cowart/canvas.html";
const DEFAULT_DISPLAY_MODE = "fullscreen";
const COWART_RESOURCE_DOMAINS = ["data:", "blob:"];

const projectArgsSchema = {
  projectDir: z.string().trim().optional(),
  canvasDir: z.string().trim().optional(),
};

const displayModeSchema = z.enum(["fullscreen", "inline"]);

const pluginManifest = JSON.parse(
  readFileSync(pluginPath(".codex-plugin", "plugin.json"), "utf8"),
);

const server = new McpServer(
  {
    name: pluginManifest.name,
    version: pluginManifest.version,
  },
  {
    instructions:
      "Render and update the native Cowart Codex widget. Use render_cowart_canvas_widget to open the canvas for the active project, get_cowart_selection for persisted widget selection, and insert_cowart_image to place bitmap assets into the project-backed canvas without hand-writing tldraw records.",
  },
);

registerCowartWidget(server);
registerCowartStateTools(server);
registerCowartImageTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function sanitizeFileName(name, fallbackName = "image.png") {
  const rawName = basename(String(name || fallbackName));
  const extension = extname(rawName) || extname(fallbackName) || ".png";
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "image"}${extension}`;
}

function sanitizeIdPart(value, fallback = "image") {
  return String(value || fallback)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function uniqueFilePath(dir, requestedName) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    try {
      await stat(candidatePath);
      candidate = `${base}-v${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: candidate, filePath: candidatePath };
      throw error;
    }
  }
}

function uniqueRecordId(store, prefix, seed) {
  const cleanSeed = sanitizeIdPart(seed);
  let candidate = `${prefix}:${cleanSeed}`;
  let counter = 2;
  while (store[candidate]) {
    candidate = `${prefix}:${cleanSeed}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function getRecord(store, id, label) {
  const record = store[id];
  if (!record) throw new Error(`Missing ${label}: ${id}`);
  return record;
}

function findPageIdForShape(store, shapeId) {
  let record = getRecord(store, shapeId, "shape");
  const visited = new Set();
  while (record && !visited.has(record.id)) {
    visited.add(record.id);
    if (record.typeName === "page") return record.id;
    const parentId = record.parentId;
    if (!parentId) break;
    const parent = store[parentId];
    if (parent?.typeName === "page") return parent.id;
    record = parent;
  }
  return null;
}

function getPageShapes(store, pageId) {
  const shapes = [];
  const byParent = new Map();
  for (const record of Object.values(store)) {
    if (record?.typeName !== "shape") continue;
    const siblings = byParent.get(record.parentId) ?? [];
    siblings.push(record);
    byParent.set(record.parentId, siblings);
  }
  const queue = [...(byParent.get(pageId) ?? [])];
  while (queue.length > 0) {
    const shape = queue.shift();
    shapes.push(shape);
    queue.push(...(byParent.get(shape.id) ?? []));
  }
  return shapes;
}

function localBoundsForShape(shape) {
  if (!shape || shape.typeName !== "shape") return null;
  if (shape.type === "arrow") {
    const start = shape.props?.start ?? { x: 0, y: 0 };
    const end = shape.props?.end ?? { x: 0, y: 0 };
    const minX = Math.min(start.x ?? 0, end.x ?? 0);
    const minY = Math.min(start.y ?? 0, end.y ?? 0);
    const maxX = Math.max(start.x ?? 0, end.x ?? 0);
    const maxY = Math.max(start.y ?? 0, end.y ?? 0);
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  const w = finiteNumber(shape.props?.w, shape.type === "text" ? 160 : 1);
  const h = finiteNumber(shape.props?.h, shape.type === "text" ? 40 : 1);
  return { x: 0, y: 0, w, h };
}

function pageBoundsForShape(store, shape) {
  const local = localBoundsForShape(shape);
  if (!local) return null;
  let x = finiteNumber(shape.x, 0) + local.x;
  let y = finiteNumber(shape.y, 0) + local.y;
  let parent = store[shape.parentId];
  const visited = new Set([shape.id]);
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    x += finiteNumber(parent.x, 0);
    y += finiteNumber(parent.y, 0);
    parent = store[parent.parentId];
  }
  return { x, y, w: local.w, h: local.h };
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

function chooseIndex(store, parentId) {
  const siblingIndexes = Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string")
    .map((record) => record.index)
    .sort();
  return generateKeyBetween(siblingIndexes.at(-1) ?? null, null);
}

function firstSelectedShapeId(selection) {
  return selection?.selectedShapes?.length === 1 ? selection.selectedShapes[0]?.id : null;
}

function choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement }) {
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  let x = anchorBounds ? anchorBounds.x + anchorBounds.w + margin : 0;
  let y = anchorBounds ? anchorBounds.y : 0;

  if (placement === "left" && anchorBounds) x = anchorBounds.x - width - margin;
  if (placement === "below" && anchorBounds) {
    x = anchorBounds.x;
    y = anchorBounds.y + anchorBounds.h + margin;
  }

  const pageShapes = getPageShapes(store, pageId);
  const obstacles = pageShapes
    .filter((shape) => shape.parentId === parentId && shape.id !== anchorShape?.id)
    .map((shape) => pageBoundsForShape(store, shape))
    .filter(Boolean);

  const stepX = Math.max(width + margin, 1);
  const stepY = Math.max(height + margin, 1);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, w: width, h: height };
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, margin / 2))) return candidate;
    if (placement === "below") y += stepY;
    else if (placement === "left") x -= stepX;
    else x += stepX;
  }

  return { x, y, w: width, h: height };
}

async function getImageDimensions(filePath) {
  const buffer = await readFile(filePath);
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }
  throw new Error(`Could not read image dimensions for ${filePath}. Pass displayWidth/displayHeight and use a PNG/JPEG/WebP source.`);
}

async function insertCowartImage(args = {}) {
  const imagePath = nonEmptyString(args.imagePath);
  if (!imagePath) throw new Error("imagePath is required.");

  const sourceImagePath = pathResolve(imagePath);
  const sourceStat = await stat(sourceImagePath);
  if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourceImagePath}`);

  const canvasState = await readCowartCanvasState(args, { hydrateAssets: false });
  const snapshot = canvasState.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error("No Cowart canvas snapshot exists yet. Open the Cowart widget for the target project and create or save the canvas before inserting images.");
  }

  const store = snapshot.store;
  const { selection } = await readCowartSelectionState(args);
  const { viewState } = await readCowartViewState(args);

  const anchorShapeId = nonEmptyString(args.anchorShapeId) || nonEmptyString(args.sourceShapeId) || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const parentId = anchorShape?.parentId && store[anchorShape.parentId]?.typeName === "page" ? anchorShape.parentId : pageId;
  const imageSize = await getImageDimensions(sourceImagePath);
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  const matchAnchor = args.matchAnchor !== false && anchorBounds;
  const width = finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.w : Math.min(imageSize.width, 512));
  const height = finiteNumber(
    args.displayHeight,
    matchAnchor ? anchorBounds.h : Math.round(width * (imageSize.height / imageSize.width)),
  );
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  const bounds = choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement });

  const canvasDir = resolveCanvasDir(args);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(resolveCanvasDir(args), assetsDir)) {
    throw new Error(`Unsafe page assets directory: ${assetsDir}`);
  }
  const { fileName, filePath } = await uniqueFilePath(assetsDir, args.fileName || basename(sourceImagePath));
  const recordSeed = sanitizeIdPart(fileName);
  const assetId = uniqueRecordId(store, "asset", recordSeed);
  const shapeId = uniqueRecordId(store, "shape", recordSeed);
  const index = chooseIndex(store, parentId);
  const mimeType = mimeTypeForFile(fileName);

  const assetRecord = {
    id: assetId,
    typeName: "asset",
    type: "image",
    props: {
      name: fileName,
      src: pageAssetUrl(pageId, fileName),
      w: imageSize.width,
      h: imageSize.height,
      fileSize: sourceStat.size,
      mimeType,
      isAnimated: false,
    },
    meta: args.assetMeta && typeof args.assetMeta === "object" ? args.assetMeta : {},
  };

  const shapeMeta = args.shapeMeta && typeof args.shapeMeta === "object" ? { ...args.shapeMeta } : {};
  if (anchorShapeId && !shapeMeta.cowartAnnotationSourceShapeId) {
    shapeMeta.cowartAnnotationSourceShapeId = anchorShapeId;
  }
  if (nonEmptyString(args.annotationScreenshot) && !shapeMeta.cowartAnnotationScreenshot) {
    shapeMeta.cowartAnnotationScreenshot = nonEmptyString(args.annotationScreenshot);
  }

  const shapeRecord = {
    x: bounds.x,
    y: bounds.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: shapeMeta,
    id: shapeId,
    type: "image",
    props: {
      w: width,
      h: height,
      assetId,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: nonEmptyString(args.altText) || "Cowart inserted image",
    },
    parentId,
    index,
    typeName: "shape",
  };

  if (!args.dryRun) {
    await mkdir(assetsDir, { recursive: true });
    await copyFile(sourceImagePath, filePath);
    store[assetId] = assetRecord;
    store[shapeId] = shapeRecord;
    await saveCowartCanvasSnapshot(args, snapshot);
  }

  return {
    canvasDir,
    cowartUrl: nonEmptyString(args.cowartUrl),
    pageId,
    parentId,
    anchorShapeId,
    assetId,
    shapeId,
    index,
    sourceImagePath,
    assetFile: filePath,
    assetUrl: assetRecord.props.src,
    imageSize,
    bounds,
    dryRun: Boolean(args.dryRun),
  };
}

function registerCowartWidget(mcpServer) {
  registerWidgetResource(mcpServer, {
    name: "cowart-canvas-widget",
    uri: COWART_WIDGET_URI,
    title: "Cowart Canvas",
    description:
      "A native Codex widget that renders Cowart's tldraw canvas directly and persists canvas data in the active project.",
    resourceDomains: COWART_RESOURCE_DOMAINS,
    html: async () => inlineWidget({
      html: await cowartStaticHtml(),
      initialDisplayMode: DEFAULT_DISPLAY_MODE,
    }),
  });

  registerAppTool(
    mcpServer,
    TOOL_RENDER_WIDGET,
    {
      title: "Render Cowart Canvas Widget",
      description:
        "Open the native Cowart canvas widget for the active Codex project. Pass projectDir for the user's workspace so canvas data is stored under <projectDir>/canvas.",
      inputSchema: {
        ...projectArgsSchema,
        title: z.string().trim().optional(),
        displayMode: displayModeSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: COWART_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": COWART_WIDGET_URI,
        "openai/outputTemplate": COWART_WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening Cowart canvas...",
        "openai/toolInvocation/invoked": "Cowart canvas ready",
      },
    },
    async (input = {}) => {
      const { projectDir, canvasDir } = resolveCowartPaths(input);
      const title = nonEmptyString(input.title) || "Cowart Canvas";
      const preferredDisplayMode = normalizeDisplayMode(input.displayMode);

      return {
        content: [
          {
            type: "text",
            text: "Rendered Cowart canvas widget.",
          },
        ],
        structuredContent: {
          version: 1,
          widget: "cowart-canvas-widget",
          title,
          rendering: "native-widget",
          staticDir: COWART_STATIC_BUILD_DIR,
          projectDir,
          canvasDir,
          preferredDisplayMode,
        },
        _meta: {
          "openai/outputTemplate": COWART_WIDGET_URI,
          widgetData: {
            title,
            rendering: "native-widget",
            staticDir: COWART_STATIC_BUILD_DIR,
            projectDir,
            canvasDir,
            preferredDisplayMode,
          },
        },
      };
    },
  );
}

function registerCowartStateTools(mcpServer) {
  mcpServer.registerTool(
    TOOL_GET_CANVAS_STATE,
    {
      title: "Get Cowart Canvas State",
      description:
        "Read the project-backed Cowart canvas snapshot, view state, and storage paths. The widget uses this instead of a localhost /api/canvas request.",
      inputSchema: {
        ...projectArgsSchema,
        hydrateAssets: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const state = await readCowartCanvasState(input, { hydrateAssets: input.hydrateAssets !== false });
      return {
        content: [
          {
            type: "text",
            text: `Loaded Cowart canvas state from ${state.canvasDir} (${state.storage}).`,
          },
        ],
        structuredContent: state,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_CANVAS_STATE,
    {
      title: "Save Cowart Canvas State",
      description:
        "Persist a Cowart/tldraw store snapshot to the project canvas directory, preserving per-page files and page-local assets.",
      inputSchema: {
        ...projectArgsSchema,
        snapshot: z.any(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await saveCowartCanvasSnapshot(input, input.snapshot);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Invalid Cowart canvas snapshot.",
            },
          ],
          structuredContent: result,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart canvas state (${result.storage}).`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_SELECTION_STATE,
    {
      title: "Save Cowart Selection State",
      description:
        "Persist the current Cowart widget selection to canvas/cowart-selection.json so Codex can target selected shapes.",
      inputSchema: {
        ...projectArgsSchema,
        selection: z.any(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await writeCowartSelectionState(input, input.selection);
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart selection state to ${result.path}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  mcpServer.registerTool(
    TOOL_SAVE_VIEW_STATE,
    {
      title: "Save Cowart View State",
      description:
        "Persist the current Cowart page and camera state to canvas/cowart-view-state.json.",
      inputSchema: {
        ...projectArgsSchema,
        viewState: z.any(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await writeCowartViewState(input, input.viewState);
      return {
        content: [
          {
            type: "text",
            text: `Saved Cowart view state to ${result.path}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );
}

function registerCowartImageTools(mcpServer) {
  mcpServer.registerTool(
    TOOL_GET_SELECTION,
    {
      title: "Get Cowart Selection",
      description:
        "Return the currently selected Cowart/tldraw shapes and image asset metadata from a project's canvas/cowart-selection.json state file.",
      inputSchema: projectArgsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const { selection, selectionFile } = await readCowartSelectionState(input);
      const selectedShapes = selection.selectedShapes ?? [];
      const summary =
        selectedShapes.length === 0
          ? "No Cowart shapes are currently selected."
          : selectedShapes
              .map((shape) => {
                const assetName = shape.asset?.name ? ` (${shape.asset.name})` : "";
                return `${shape.id} [${shape.type ?? "unknown"}]${assetName}`;
              })
              .join("\n");

      return {
        content: [{ type: "text", text: summary }],
        structuredContent: { selection, selectionFile },
      };
    },
  );

  mcpServer.registerTool(
    TOOL_INSERT_IMAGE,
    {
      title: "Insert Cowart Image",
      description:
        "Copy a local bitmap into a Cowart page-local assets folder, create a tldraw image asset and shape, place it beside an anchor or clear page area, and save the project-backed Cowart canvas.",
      inputSchema: {
        imagePath: z.string().trim(),
        projectDir: z.string().trim().optional(),
        canvasDir: z.string().trim().optional(),
        cowartUrl: z.string().trim().optional(),
        pageId: z.string().trim().optional(),
        anchorShapeId: z.string().trim().optional(),
        sourceShapeId: z.string().trim().optional(),
        fileName: z.string().trim().optional(),
        placement: z.enum(["right", "left", "below"]).optional(),
        margin: z.number().optional(),
        matchAnchor: z.boolean().optional(),
        displayWidth: z.number().optional(),
        displayHeight: z.number().optional(),
        altText: z.string().trim().optional(),
        annotationScreenshot: z.string().trim().optional(),
        shapeMeta: z.record(z.string(), z.unknown()).optional(),
        assetMeta: z.record(z.string(), z.unknown()).optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await insertCowartImage(input);
      return {
        content: [
          {
            type: "text",
            text: `${result.dryRun ? "Planned" : "Inserted"} ${result.shapeId} on ${result.pageId} at (${result.bounds.x}, ${result.bounds.y}) using ${result.index}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );
}

function normalizeDisplayMode(displayMode) {
  const parsed = displayModeSchema.safeParse(displayMode);
  return parsed.success ? parsed.data : DEFAULT_DISPLAY_MODE;
}
