import { Buffer } from "buffer";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const CACHE_DIR_NAME = "../imgs/cache"; 
const imageCache = new Map<string, { value: string; expiresAt: number; lastUsed: number }>();
const IMAGE_CACHE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 50;
const CACHE_EVICTION_PERCENTAGE = 0.2;

// Layout Constants
const VIEWBOX_SIZE = 100;
const BORDER_RADIUS = 15;
const INNER_RECT_SIZE = 98;
const INNER_RECT_OFFSET = 1;
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONT_WEIGHT = "600";

// Path construction constants to avoid magic numbers in SVG paths
const PATH_MIN = INNER_RECT_OFFSET; // 1
const PATH_MAX = VIEWBOX_SIZE - INNER_RECT_OFFSET; // 99
const ARC_START = INNER_RECT_OFFSET + BORDER_RADIUS; // 16
const ARC_END = VIEWBOX_SIZE - (INNER_RECT_OFFSET + BORDER_RADIUS); // 84

// Border layout constants
// Logical center of the 100x100 viewBox for splitting grid cells.
const CENTER_X = 50;
const CENTER_Y = 50;
// Half-pixel gap used to separate borders along the center lines to prevent color bleeding.
const CENTER_LINE_GAP = 0.5;
// Derived center positions with the gap applied.
const CENTER_X_LEFT = CENTER_X - CENTER_LINE_GAP;   // 49.5
const CENTER_X_RIGHT = CENTER_X + CENTER_LINE_GAP;  // 50.5
const CENTER_Y_TOP = CENTER_Y - CENTER_LINE_GAP;    // 49.5
const CENTER_Y_BOTTOM = CENTER_Y + CENTER_LINE_GAP; // 50.5
// Junction offsets for the 3-grid layout: where the top border stops and sides start.
const TOP_JUNCTION_Y = 16.5;
const SIDE_JUNCTION_Y = 17.5;

export async function getLocalProfileImage(slug: string, url: string): Promise<string | undefined> {
  // Determine cache directory relative to the plugin binary
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const cacheDir = path.resolve(currentDir, CACHE_DIR_NAME);
  
  // Ensure cache dir exists
  try {
      await fs.mkdir(cacheDir, { recursive: true });
  } catch (e) {
      console.warn(`[IMAGE_UTILS] Failed to create cache dir ${cacheDir}`, e);
  }

  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase() || "jpg";
  // Sanitize slug for filename
  const safeSlug = slug.replace(/[^a-z0-9_-]/gi, "_");
  const filename = `${safeSlug}.${ext}`;
  const filePath = path.join(cacheDir, filename);
  
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    // File doesn't exist, fetch it
  }

  try {
    // console.log(`[IMAGE_UTILS] Fetching profile image for ${slug} from ${url}`);
    const response = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
    });
    
    if (!response.ok) {
      throw new Error(`Image request failed with ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    
    return filePath;
  } catch (_error) {
    // console.error(`[IMAGE_UTILS] Failed to download profile image for ${slug}`, error);
    return undefined;
  }
}

export function getProcessedImage(
  colorDataUri: string, 
  isLive: boolean,
  textOverlay?: { title: string; subtitle?: string }
): string {
  const fullCacheKey = `${colorDataUri}-${isLive}-${JSON.stringify(textOverlay)}`;
  const cached = imageCache.get(fullCacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    // Update usage time without mutating the existing cached object
    imageCache.set(fullCacheKey, { ...cached, lastUsed: now });
    return cached.value;
  }
  
  // Prune cache if too big
  if (imageCache.size >= MAX_CACHE_SIZE) {
      // Sort by lastUsed (LRU) and remove oldest
      const sortedEntries = Array.from(imageCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      
      // Remove oldest 20%
      const toRemove = Math.ceil(MAX_CACHE_SIZE * CACHE_EVICTION_PERCENTAGE);
      for (let i = 0; i < toRemove; i++) {
          if (sortedEntries[i]) {
              imageCache.delete(sortedEntries[i][0]);
          }
      }
  }

  const borderColor = isLive ? "#53fc18" : "#ff0000";
  
  const textElements = renderTextOverlay(textOverlay);
  
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}">
  <defs>
    <filter id="grayscale">
      <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0" />
    </filter>
    <filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="black" flood-opacity="0.8"/>
    </filter>
    <clipPath id="clip">
      <rect x="${INNER_RECT_OFFSET}" y="${INNER_RECT_OFFSET}" width="${INNER_RECT_SIZE}" height="${INNER_RECT_SIZE}" rx="${BORDER_RADIUS}" ry="${BORDER_RADIUS}" />
    </clipPath>
  </defs>
  <rect width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" fill="#000" />
  <image href="${colorDataUri}" x="0" y="0" width="${VIEWBOX_SIZE}" height="${VIEWBOX_SIZE}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clip)" ${!isLive ? 'filter="url(#grayscale)"' : ''} />
  <rect x="${INNER_RECT_OFFSET}" y="${INNER_RECT_OFFSET}" width="${INNER_RECT_SIZE}" height="${INNER_RECT_SIZE}" rx="${BORDER_RADIUS}" ry="${BORDER_RADIUS}" fill="none" stroke="${borderColor}" stroke-width="2" />
  ${textElements}
</svg>`;

  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

  imageCache.set(fullCacheKey, {
    value: dataUri,
    expiresAt: now + IMAGE_CACHE_MS,
    lastUsed: now
  });

  return dataUri;
}

const ESCAPE_XML_MAP: Record<string, string> = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '\'': '&apos;',
    '"': '&quot;',
};

function escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&'"]/g, (c) => ESCAPE_XML_MAP[c] ?? c);
}

function renderTextOverlay(textOverlay?: { title: string; subtitle?: string }): string {
    if (!textOverlay) return "";
    
    let textElements = "";
    
    // Subtitle (Category)
    // Render subtitle first so title can adjust if needed, or just fixed positions.
    // Actually, let's calculate positions first.
    
    const hasSubtitle = !!textOverlay.subtitle;
    let titleY = hasSubtitle ? 60 : 50; // Move title up if subtitle exists
    
    // Title (Streamer Name)
    if (textOverlay.title) {
        const titleLines = textOverlay.title.split('\n');
        const maxLineLength = Math.max(...titleLines.map(l => l.length));
        
        const verticalConstraint = titleLines.length > 1 ? 20 : 24;
        const fontSize = Math.max(14, Math.min(verticalConstraint, Math.floor(170 / maxLineLength)));
        
        if (!hasSubtitle && titleLines.length > 1) {
            const lineHeight = fontSize * 1.1;
            const totalHeight = titleLines.length * lineHeight;
            titleY = 50 - (totalHeight / 2) + (fontSize / 2);
        }

        titleLines.forEach((line, i) => {
            const y = titleY + (i * (fontSize * 1.1));
            textElements += `<text x="50" y="${y}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${fontSize}" text-anchor="middle" fill="white" filter="url(#textShadow)">${escapeXml(line)}</text>`;
        });
    }
    
    // Subtitle (Category)
    if (textOverlay.subtitle) {
        const lines = textOverlay.subtitle.split('\n');
        const maxLen = Math.max(...lines.map(l => l.length));
        
        // Increased font size range: 14-20 (was 9-12)
        const subFontSize = Math.max(14, Math.min(20, Math.floor(220 / maxLen)));
        
        // Position logic
        // If 1 line, y=92. If 2 lines, start higher?
        // Let's just use fixed start for now, assuming 1-2 lines max.
        // If 2 lines, 82 and 96 (approx).
        const startY = lines.length > 1 ? 82 : 92;
        
        lines.forEach((line, i) => {
            const y = startY + (i * subFontSize);
            // Changed to bold white text
            textElements += `<text x="50" y="${y}" font-family="${FONT_FAMILY}" font-weight="${FONT_WEIGHT}" font-size="${subFontSize}" text-anchor="middle" fill="white" filter="url(#textShadow)">${escapeXml(line)}</text>`;
        });
    }
    
    return textElements;
}

export function generateCollageSvg(
    items: { image: string; isLive: boolean; isFlashing?: boolean }[],
    textOverlay?: { title: string; subtitle?: string }
): string {
    const count = items.length;
    if (count === 0) return "";
    
    if (count === 1) {
        // If single item is flashing, return a solid green or special effect
        if (items[0].isFlashing) {
             // Return a simple green square SVG
             const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#53fc18" rx="15" ry="15" />
</svg>`;
             return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
        }
        return getProcessedImage(items[0].image, items[0].isLive, textOverlay);
    }


    // Generate Patterns for each image
    const patterns = items.map((item, index) => `
    <pattern id="pat${index}" patternUnits="userSpaceOnUse" width="100" height="100">
        <image href="${item.image}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid slice" ${!item.isLive ? 'filter="url(#grayscale)"' : ''} />
    </pattern>`).join("\n");

    // Define geometries for clips and fills
    let geometries: { tag: string; attrs: string }[] = [];
    let separators = "";

    if (count === 2) {
        // Vertical Split
        geometries = [
            { tag: 'rect', attrs: 'x="0" y="0" width="50" height="100"' },
            { tag: 'rect', attrs: 'x="50" y="0" width="50" height="100"' }
        ];
        separators = `<line x1="50" y1="0" x2="50" y2="100" stroke="black" stroke-width="2" />`;
    } else if (count === 3) {
        // Inverted Y-Split (Mercedes Inverted)
        // Matches the border logic where the top section spans roughly 120 degrees
        // Split points at (0, 17) and (100, 17)
        geometries = [
            { tag: 'polygon', attrs: 'points="50,50 0,17 0,0 100,0 100,17"' }, // Top
            { tag: 'polygon', attrs: 'points="50,50 100,17 100,100 50,100"' }, // Right
            { tag: 'polygon', attrs: 'points="50,50 50,100 0,100 0,17"' } // Left
        ];
        separators = `
            <line x1="50" y1="50" x2="0" y2="17" stroke="black" stroke-width="2" />
            <line x1="50" y1="50" x2="100" y2="17" stroke="black" stroke-width="2" />
            <line x1="50" y1="50" x2="50" y2="100" stroke="black" stroke-width="2" />
        `;
    } else {
        // 4-Grid (or fallback for >4)
        geometries = [
            { tag: 'rect', attrs: 'x="0" y="0" width="50" height="50"' }, // TL
            { tag: 'rect', attrs: 'x="50" y="0" width="50" height="50"' }, // TR
            { tag: 'rect', attrs: 'x="0" y="50" width="50" height="50"' }, // BL
            { tag: 'rect', attrs: 'x="50" y="50" width="50" height="50"' } // BR
        ];
        separators = `
            <line x1="50" y1="0" x2="50" y2="100" stroke="black" stroke-width="2" />
            <line x1="0" y1="50" x2="100" y2="50" stroke="black" stroke-width="2" />
        `;
    }

    // Create Clip Paths definitions
    const clipDefs = geometries.map((geo, i) => `<clipPath id="clip${i}"><${geo.tag} ${geo.attrs} /></clipPath>`).join("\n");

    // Render Image Fills (using the geometries directly with fill=url(#patN))
    const imageShapes = geometries.map((geo, i) => {
        let fill = `url(#pat${i})`;
        if (items[i] && items[i].isFlashing) {
            fill = "#53fc18";
        }
        return `<${geo.tag} ${geo.attrs} fill="${fill}" />`;
    }).join("\n");

    // Render Borders using explicit paths to avoid clip-path issues
    // We add slight gaps (0.5px) at the junctions to prevent color bleeding and overlap
    let borderPaths: string[] = [];
    
    if (count === 2) {
        borderPaths = [
            // Left: Stop at x=CENTER_X_LEFT
            `M ${CENTER_X_LEFT},${PATH_MIN} L ${ARC_START},${PATH_MIN} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 0 ${PATH_MIN},${ARC_START} L ${PATH_MIN},${ARC_END} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 0 ${ARC_START},${PATH_MAX} L ${CENTER_X_LEFT},${PATH_MAX}`,
            // Right: Start at x=CENTER_X_RIGHT
            `M ${CENTER_X_RIGHT},${PATH_MIN} L ${ARC_END},${PATH_MIN} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${PATH_MAX},${ARC_START} L ${PATH_MAX},${ARC_END} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${ARC_END},${PATH_MAX} L ${CENTER_X_RIGHT},${PATH_MAX}`
        ];
    } else if (count === 3) {
        borderPaths = [
            // Top: Ends at y=TOP_JUNCTION_Y on both sides.
            `M ${PATH_MIN},${TOP_JUNCTION_Y} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${ARC_START},${PATH_MIN} L ${ARC_END},${PATH_MIN} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${PATH_MAX},${TOP_JUNCTION_Y}`,
            // Right: Starts at y=SIDE_JUNCTION_Y. Ends at x=CENTER_X_RIGHT.
            `M ${PATH_MAX},${SIDE_JUNCTION_Y} L ${PATH_MAX},${ARC_END} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${ARC_END},${PATH_MAX} L ${CENTER_X_RIGHT},${PATH_MAX}`,
            // Left: Starts at x=CENTER_X_LEFT. Ends at y=SIDE_JUNCTION_Y.
            `M ${CENTER_X_LEFT},${PATH_MAX} L ${ARC_START},${PATH_MAX} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${PATH_MIN},${ARC_END} L ${PATH_MIN},${SIDE_JUNCTION_Y}`
        ];
    } else {
        // 4-Grid: Gap everything by CENTER_LINE_GAP from the center lines (x=50, y=50)
        borderPaths = [
            // TL
            `M ${CENTER_X_LEFT},${PATH_MIN} L ${ARC_START},${PATH_MIN} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 0 ${PATH_MIN},${ARC_START} L ${PATH_MIN},${CENTER_Y_TOP}`,
            // TR
            `M ${CENTER_X_RIGHT},${PATH_MIN} L ${ARC_END},${PATH_MIN} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${PATH_MAX},${ARC_START} L ${PATH_MAX},${CENTER_Y_TOP}`,
            // BL
            `M ${PATH_MIN},${CENTER_Y_BOTTOM} L ${PATH_MIN},${ARC_END} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 0 ${ARC_START},${PATH_MAX} L ${CENTER_X_LEFT},${PATH_MAX}`,
            // BR
            `M ${PATH_MAX},${CENTER_Y_BOTTOM} L ${PATH_MAX},${ARC_END} A ${BORDER_RADIUS},${BORDER_RADIUS} 0 0 1 ${ARC_END},${PATH_MAX} L ${CENTER_X_RIGHT},${PATH_MAX}`
        ];
    }

    const borders = items.slice(0, 4).map((item, i) => {
        if (!borderPaths[i] || !item) return "";
        const color = item.isLive ? "#53fc18" : "#ff0000";
        return `<path d="${borderPaths[i]}" fill="none" stroke="${color}" stroke-width="2" />`;
    }).join("\n");

    const textElements = renderTextOverlay(textOverlay);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <filter id="grayscale">
      <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0" />
    </filter>
    <clipPath id="mainClip">
      <rect x="1" y="1" width="98" height="98" rx="15" ry="15" />
    </clipPath>
    ${patterns}
    ${clipDefs}
  </defs>
  
  <rect width="100" height="100" fill="#000" />
  
  <g clip-path="url(#mainClip)">
    ${imageShapes}
    ${separators}
  </g>
  
  ${borders}
  ${textElements}
</svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
