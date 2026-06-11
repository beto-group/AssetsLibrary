const { useEffect, useRef, useState, useMemo, useCallback, useReducer } = dc;

// --- 1. Core & Shared ---
// This section contains global constants, shared state, utility functions, and the web worker logic.
// 
// PERFORMANCE OPTIMIZATION: Parallel Loading Flow
// When user consents, three processes run simultaneously for maximum speed:
// 1. Canvas file loading - loads existing SVG files and renders them immediately
// 2. GitHub sync - downloads new .md files from beto-group/beto.assets (2 concurrent workers)
//    - SMART SYNC: Initial consent triggers immediate pull, then only syncs:
//      • Weekly (every 7 days) if folder contains .md files
//      • Immediately if folder is empty (no .md files present)
//    - Tracks last sync timestamp in consent.json file
// 3. SVG conversion - converts .md files to .svg in background as they're downloaded
//    - DEPENDENCY-AWARE: Files with dependencies convert LAST after independent files
//    - Detects [[file]] references and reorders conversion queue accordingly
// All three processes are non-blocking and update the UI progressively as they complete.
//
// RENDERING OPTIMIZATION: Prevents Duplicate Renders & Smooth Spawning
// - Images cached in globalImageCache with mtime validation
// - requestedSet tracks in-flight requests to prevent duplicate loads
// - Debounced file change detection (500ms) to batch conversion checks
// - Canvas only requests images that aren't cached or already requested
// - High-res bitmaps automatically cleaned when off-screen to save memory
// - Staggered spawn delays (2-3ms per item) for silky smooth cascade effect
// - Viewport-aware loading: only loads visible items first (progressive enhancement)
// - Batch limits: Grid 16 items/frame, Graph 16 items/frame (prevents frame drops)
// - Existing items keep their positions, only new items animate in
//
// GRID MODE PHYSICS: Drag & Throw Individual Images
// - Left-click drag on any image to move it around (no pan key needed)
// - BULLDOZER MODE: Dragged item FORCES through others (never gets pushed back!)
//   • Dragged item is immune to collision forces while being dragged
//   • Only OTHER items receive push forces and are moved out of the way
//   • Result: Smooth plowing through crowds at any speed
// - CONTINUOUS COLLISION DETECTION: Sweeps along drag path every frame
//   • Fixed 15px step size for consistent collision checks
//   • Checks all positions between previous and current cursor location
//   • Pushes ALL items encountered along the entire path
// - STRONG COLLISION FORCES: Scales with drag speed
//   • Base impulse: 1.5x overlap (immediate push from penetration)
//   • Velocity impulse: 0.8x drag speed (faster drag = harder hit)
//   • Separation: 90% of overlap (aggressively clears the path)
// - Hit images fly away with momentum: velocity decay (0.92) + spring force back to grid
// - Pan/zoom still works: Middle/right-click or hold Space + drag
//
// LAG SPIKE PREVENTION: Strategic Yield Points
// - setTimeout(0) yields to UI thread every 2-3 operations
// - GitHub sync: yields every 3 files during download/conversion
// - Conversion: yields before parse, SVG generation, and file write
// - Batch conversion: single worker with yields every 2 files
// - Progress updates throttled (every 2 files) to reduce UI repaints
// - Reduced concurrency: 2 workers instead of 3 for smoother performance

const FOLDER_PATH = "_RESOURCES/ASSETS/888/ASSETS_.A";
const EXPORT_SCALE = 2;
const LOCAL_FONTS_DIR = "data/fonts/futura"; // Local fonts cache directory
const LOCAL_FONT_PATH = "data/fonts/futura/Futura-CondensedLight.otf"; // Main font file
const REPO_FONTS_PATH = "_RESOURCES/FONTS/futura"; // Repo fonts directory path
const EXPORT_PADDING = 15;
const EXCALIDRAW_CDN_URL = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.17.6/+esm";
const EXCALIDRAW_ASSET_PATH = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.17.6/dist/";
const LZ_STRING_CDN_URL = "https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js";
const REACT_CDN_URL = "https://unpkg.com/react@18.2.0/umd/react.production.min.js";
const REACT_DOM_CDN_URL = "https://unpkg.com/react-dom@18.2.0/umd/react-dom.production.min.js";
const MAX_CONCURRENCY = 1;

// GitHub repo configuration
const GITHUB_REPO_OWNER = "beto-group";
const GITHUB_REPO_NAME = "beto.assets";
const GITHUB_ASSETS_PATH = "ASSETS";
const GITHUB_BRANCH = "main";

const Core = {
    // --- Shared State ---
    globalImageCache: new Map(),
    REMOVED_IMAGES_PATH: ".datacore/image-gallery/removed.json",

    // --- Font Handling ---
    loadFontData: async (log, currentFilePath) => {
        try {
            // Calculate relative font directory based on current file location
            let localFontsDir = LOCAL_FONTS_DIR;
            let localFontPath = LOCAL_FONT_PATH;
            
            if (currentFilePath) {
                // Get directory of current file
                const currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
                localFontsDir = `${currentDir}/${LOCAL_FONTS_DIR}`;
                localFontPath = `${currentDir}/${LOCAL_FONT_PATH}`;
            }
            
            // Check if main font exists locally first
            const localExists = await dc.app.vault.adapter.exists(localFontPath);
            
            if (localExists) {
                if (log) log('✅ Font found locally, loading from cache...');
                return await dc.app.vault.adapter.readBinary(localFontPath);
            }
            
            // Font not found locally, fetch entire futura folder from beto.assets repo
            if (log) log('📥 Fonts not found locally, fetching futura folder from beto.assets repo...');
            
            // First, get the directory listing from GitHub API
            const apiUrl = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${REPO_FONTS_PATH}?ref=${GITHUB_BRANCH}`;
            const dirResponse = await fetch(apiUrl);
            
            if (!dirResponse.ok) {
                throw new Error(`Failed to fetch directory listing: ${dirResponse.status} ${dirResponse.statusText}`);
            }
            
            const files = await dirResponse.json();
            
            if (!Array.isArray(files)) {
                throw new Error('Invalid response from GitHub API');
            }
            
            // Create local fonts directory recursively if it doesn't exist
            // Split path and create each part
            const pathParts = localFontsDir.split('/');
            let currentPath = '';
            for (const part of pathParts) {
                if (!part) continue;
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                
                if (!(await dc.app.vault.adapter.exists(currentPath))) {
                    if (log) log(`📁 Creating directory: ${currentPath}`);
                    await dc.app.vault.adapter.mkdir(currentPath);
                }
            }
            
            // Download all font files
            let mainFontData = null;
            const downloadPromises = files.map(async (file) => {
                if (file.type === 'file') {
                    try {
                        if (log) log(`  ⬇️  Downloading: ${file.name}`);
                        const response = await fetch(file.download_url);
                        
                        if (!response.ok) {
                            throw new Error(`Failed to download ${file.name}`);
                        }
                        
                        const arrayBuffer = await response.arrayBuffer();
                        const filePath = `${localFontsDir}/${file.name}`;
                        
                        await dc.app.vault.adapter.writeBinary(filePath, arrayBuffer);
                        if (log) log(`  ✅ Saved: ${file.name}`);
                        
                        // If this is the main font file, store it to return
                        if (file.name === 'Futura-CondensedLight.otf') {
                            mainFontData = arrayBuffer;
                        }
                    } catch (error) {
                        if (log) log(`  ❌ Failed to download ${file.name}: ${error.message}`);
                        console.error(`[FontHandler] Error downloading ${file.name}:`, error);
                    }
                }
            });
            
            await Promise.all(downloadPromises);
            
            if (!mainFontData) {
                throw new Error('Main font file (Futura-CondensedLight.otf) not found in repo');
            }
            
            if (log) log(`✅ All fonts cached at: ${localFontsDir}`);
            return mainFontData;
            
        } catch (error) {
            if (log) log(`❌ Error loading fonts: ${error.message}`);
            console.error('[FontHandler] Error loading fonts:', error);
            throw error;
        }
    },

    // --- Persistence Helpers ---
    loadRemovedImagePaths: async () => {
        try {
            if (await dc.app.vault.adapter.exists(Core.REMOVED_IMAGES_PATH)) {
                const content = await dc.app.vault.adapter.read(Core.REMOVED_IMAGES_PATH);
                const paths = JSON.parse(content || "[]");
                return new Set(Array.isArray(paths) ? paths : []);
            }
        } catch (err) {
            console.error("Error loading removed images list:", err);
        }
        return new Set();
    },
    saveRemovedImagePaths: async (removedPathsSet) => {
        try {
            const dir = Core.REMOVED_IMAGES_PATH.substring(0, Core.REMOVED_IMAGES_PATH.lastIndexOf("/"));
            const dirParts = dir.split('/');
            let currentPath = '';
            for (const part of dirParts) {
                if (!part) continue;
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                if (!(await dc.app.vault.adapter.exists(currentPath))) {
                    await dc.app.vault.adapter.mkdir(currentPath);
                }
            }
            const pathsArray = Array.from(removedPathsSet);
            await dc.app.vault.adapter.write(Core.REMOVED_IMAGES_PATH, JSON.stringify(pathsArray, null, 2));
        } catch (err) {
            console.error("Error saving removed images list:", err);
        }
    },

    // --- DOM Helpers ---
    findNearestAncestorWithClass: (element, className) => {
        if (!element) return null;
        let current = element.parentNode;
        while (current) {
            if (current.classList && current.classList.contains(className)) return current;
            current = current.parentNode;
        }
        return null;
    },
    findDirectChildByClass: (parent, className) => {
        if (!parent) return null;
        for (const child of parent.children) {
            if (child.classList && child.classList.contains(className)) return child;
        }
        return null;
    },

    // --- Web Worker Logic ---
    imageWorkerCode: self.onmessage = async (e) => {
        const { type, imagesToLoad } = e.data || {};
        if (type !== 'generate') return;
        const results = {}, transferable = [], fallback = [];
        for (const { path, svgText, targetWidth, targetHeight, isHires } of imagesToLoad) {
            const W = targetWidth || 240, H = targetHeight || 300;
            try {
                const blob = new Blob([svgText], { type: 'image/svg+xml' });
                const bmp = await createImageBitmap(blob);
                const c = new OffscreenCanvas(W, H);
                const ctx = c.getContext('2d', { alpha: true });
                const iw = Math.max(1, bmp.width || 1), ih = Math.max(1, bmp.height || 1);
                const s = Math.min(W / iw, H / ih);
                const dw = Math.max(1, Math.round(iw * s)), dh = Math.max(1, Math.round(ih * s));
                const dx = Math.floor((W - dw) / 2), dy = Math.floor((H - dh) / 2);
                ctx.clearRect(0, 0, W, H);
                ctx.drawImage(bmp, dx, dy, dw, dh);
                const out = c.transferToImageBitmap ? c.transferToImageBitmap() : await createImageBitmap(c);
                results[path] = { bitmap: out, isHires: !!isHires };
                transferable.push(out);
                bmp.close?.();
            } catch (err) {
                fallback.push({ path, svgText, isHires });
            }
        }
        self.postMessage({ type: 'generated', results, fallback }, transferable);
    },

    // --- Placeholder Drawing Function ---
    drawPlaceholder: (ctx, file, x, y, w, h, isError) => {
        ctx.fillStyle = isError ? '#401010' : '#2b1a20';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(200, 180, 220, 0.5)';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const name = file.basename.replace('.svg', '');
        const maxChars = Math.floor(w / 7);
        const line1 = name.substring(0, maxChars);
        const line2 = name.length > maxChars ? name.substring(maxChars, maxChars * 2) + (name.length > maxChars * 2 ? '...' : '') : '';
        ctx.fillText(line1, x + w / 2, y + h / 2 - (line2 ? 8 : 0));
        if (line2) { ctx.fillText(line2, x + w / 2, y + h / 2 + 8); }
    },

    // --- GitHub Asset Fetching ---
    GitHub: {
        /**
         * Fetches the list of .md files from the GitHub repo
         * @param {Function} log - Logging function
         * @returns {Promise<Array<{name: string, download_url: string}>>}
         */
        fetchAssetsList: async (log, config) => {
            const repoOwner = config?.repoOwner || GITHUB_REPO_OWNER;
            const repoName = config?.repoName || GITHUB_REPO_NAME;
            const assetsPath = (config?.assetsPath || GITHUB_ASSETS_PATH).replace(/^\/|\/$/g, '');
            const branch = config?.branch || GITHUB_BRANCH;
            const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/${branch}?recursive=1`;
            log(`Fetching recursive assets tree from GitHub...`);
            
            try {
                const response = await fetch(apiUrl);
                if (!response.ok) {
                    throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
                }
                
                const data = await response.json();
                const tree = data.tree || [];
                
                // Filter for .md files inside the specified assetsPath (case-insensitive)
                const mdFiles = tree
                    .filter(file => 
                        file.type === 'blob' && 
                        file.path.toLowerCase().endsWith('.md') &&
                        (!assetsPath || file.path.toLowerCase().startsWith(assetsPath.toLowerCase() + '/'))
                    )
                    .map(file => ({
                        name: file.path.split('/').pop(),
                        path: file.path,
                        download_url: `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${file.path}`
                    }));
                
                log(`Found ${mdFiles.length} recursive .md files in GitHub repo`);
                return mdFiles;
            } catch (error) {
                log(`ERROR fetching from GitHub: ${error.message}`);
                throw error;
            }
        },

        /**
         * Downloads a single file from GitHub and saves it to the vault
         * @param {string} downloadUrl - The raw content URL
         * @param {string} fileName - Name of the file
         * @param {string} targetFolder - Folder path in vault
         * @param {Function} log - Logging function
         * @param {boolean} forceDownload - Force download even if file exists
         * @returns {Promise<{success: boolean, skipped: boolean, filePath: string}>}
         */
        downloadFile: async (downloadUrl, fileName, targetFolder, log, forceDownload = false) => {
            try {
                const filePath = `${targetFolder}/${fileName}`;
                
                // Check if file already exists
                const existingFile = dc.app.vault.getAbstractFileByPath(filePath);
                if (existingFile && !forceDownload) {
                    log(`Skipped (exists): ${fileName}`);
                    return { success: true, skipped: true, filePath };
                }
                
                const response = await fetch(downloadUrl);
                if (!response.ok) {
                    throw new Error(`Failed to download ${fileName}: ${response.status}`);
                }
                
                const content = await response.text();
                
                // Ensure folder exists recursively
                const folderParts = targetFolder.split('/');
                let currentPath = '';
                for (const part of folderParts) {
                    if (!part) continue;
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    if (!(await dc.app.vault.adapter.exists(currentPath))) {
                        await dc.app.vault.adapter.mkdir(currentPath);
                    }
                }
                
                if (existingFile) {
                    // Update existing file
                    await dc.app.vault.adapter.write(filePath, content);
                    log(`Updated: ${fileName}`);
                } else {
                    // Create new file
                    await dc.app.vault.create(filePath, content);
                    log(`Downloaded: ${fileName}`);
                }
                
                return { success: true, skipped: false, filePath };
            } catch (error) {
                log(`ERROR downloading ${fileName}: ${error.message}`);
                return { success: false, skipped: false, filePath: null };
            }
        },

        /**
         * Downloads all .md files from GitHub repo to the local folder
         * Downloads and converts in parallel for efficiency with yield points to prevent lag
         * @param {Function} log - Logging function
         * @param {Function} onProgress - Progress callback (downloaded, converted, total, skipped)
         * @param {Object} converterDeps - Converter dependencies {ExcalidrawModule, LZString, fontData}
         * @param {boolean} forceDownload - Force download even if files exist
         * @returns {Promise<{downloaded: number, skipped: number, converted: number, failed: number}>}
         */
        downloadAllAssets: async (log, onProgress, converterDeps, config, forceDownload = false, isCancelledRef = null) => {
            log('Starting GitHub asset sync...');
            
            try {
                // Fetch list of files (yield to prevent blocking)
                await new Promise(resolve => setTimeout(resolve, 0));
                const files = await Core.GitHub.fetchAssetsList(log, config);
                
                if (files.length === 0) {
                    log('No .md files found in GitHub repo');
                    return { downloaded: 0, skipped: 0, converted: 0, failed: 0 };
                }
                
                let downloadedCount = 0;
                let skippedCount = 0;
                let convertedCount = 0;
                let failedCount = 0;
                let processedCount = 0;
                
                // Process files with limited concurrency and yield points
                const processingQueue = [...files];
                const workers = [];
                
                const worker = async () => {
                    while (processingQueue.length > 0) {
                        if (isCancelledRef?.current) {
                            log("Sync cancelled by user, stopping sync workers...");
                            break;
                        }
                        const file = processingQueue.shift();
                        if (!file) continue;
                        
                        // Yield to UI thread every 3 files to prevent lag spikes
                        if (processedCount % 3 === 0) {
                            await new Promise(resolve => setTimeout(resolve, 0));
                        }
                        
                        // Determine relative path under assetsPath to preserve nested folders
                        let relativeSubpath = file.path;
                        if (config?.assetsPath) {
                            const prefix = config.assetsPath.replace(/^\/|\/$/g, '');
                            if (file.path.startsWith(prefix + '/')) {
                                relativeSubpath = file.path.substring(prefix.length + 1);
                            }
                        }
                        
                        const parts = relativeSubpath.split('/');
                        const fileName = parts.pop();
                        
                        let fileFolder = config?.localPath || FOLDER_PATH;
                        if (parts.length > 0) {
                            fileFolder = `${fileFolder}/${parts.join('/')}`;
                        }

                        // Step 1: Download (or skip if exists)
                        const downloadResult = await Core.GitHub.downloadFile(
                            file.download_url,
                            fileName,
                            fileFolder,
                            log,
                            forceDownload
                        );
                        
                        if (downloadResult.success) {
                            if (downloadResult.skipped) {
                                skippedCount++;
                            } else {
                                downloadedCount++;
                            }
                            
                            // Step 2: Convert immediately after download (or if file was skipped but needs conversion)
                            if (downloadResult.filePath && converterDeps) {
                                try {
                                    const svgPath = downloadResult.filePath.replace(/\.md$/i, '.svg');
                                    const svgExists = dc.app.vault.getAbstractFileByPath(svgPath);
                                    
                                    // Convert if SVG doesn't exist or if file was just downloaded
                                    if (!svgExists || !downloadResult.skipped) {
                                        const mdFile = dc.app.vault.getAbstractFileByPath(downloadResult.filePath);
                                        if (mdFile) {
                                            // Yield before heavy conversion operation
                                            await new Promise(resolve => setTimeout(resolve, 0));
                                            
                                            const conversionResult = await Core.Converter.processFileWithLibrary(
                                                downloadResult.filePath,
                                                converterDeps.ExcalidrawModule,
                                                converterDeps.LZString,
                                                converterDeps.fontData,
                                                log
                                            );
                                            
                                            if (conversionResult.success && !conversionResult.skipped) {
                                                convertedCount++;
                                            }
                                        }
                                    } else {
                                        log(`Skipped conversion (SVG exists): ${file.name}`);
                                    }
                                } catch (convError) {
                                    log(`Conversion error for ${file.name}: ${convError.message}`);
                                }
                            }
                        } else {
                            failedCount++;
                        }
                        
                        processedCount++;
                        
                        // Update progress (throttled to prevent too many UI updates)
                        if (onProgress && processedCount % 2 === 0) {
                            const total = files.length;
                            onProgress(downloadedCount + skippedCount + failedCount, convertedCount, total, skippedCount);
                        }
                    }
                };
                
                // Run with limited concurrency (2 parallel workers instead of 3 for smoother performance)
                const concurrency = 2;
                for (let i = 0; i < Math.min(concurrency, files.length); i++) {
                    workers.push(worker());
                }
                
                await Promise.all(workers);
                
                // Final progress update
                if (onProgress) {
                    onProgress(downloadedCount + skippedCount + failedCount, convertedCount, files.length, skippedCount);
                }
                
                log(`Sync complete: ${downloadedCount} downloaded, ${skippedCount} skipped, ${convertedCount} converted, ${failedCount} failed`);
                return { downloaded: downloadedCount, skipped: skippedCount, converted: convertedCount, failed: failedCount };
                
            } catch (error) {
                log(`CRITICAL ERROR during sync: ${error.message}`);
                throw error;
            }
        }
    },

    // --- SVG Conversion Logic (Enhanced from SVGConverter) ---
    Converter: {
        /**
         * Parse Excalidraw data from .md file with proper error handling
         */
        parseExcalidrawData: async (filePath, LZString, log) => {
            const mdContent = await dc.app.vault.adapter.read(filePath);
            
            // Try compressed JSON first
            const compressedRegex = /```compressed-json\n([\s\S]*?)\n```/;
            let match = mdContent.match(compressedRegex);
            let jsonString;
            
            if (match && match[1]) {
                jsonString = LZString.decompressFromBase64(match[1].replace(/\s/g, ''));
                if (!jsonString) throw new Error("Decompression failure.");
            } else {
                // Try regular JSON code block
                const fallbackRegex = /```(?:json|excalidraw)\n([\s\S]*?)\n```/;
                match = mdContent.match(fallbackRegex);
                if (match && match[1]) {
                    jsonString = match[1];
                }
            }

            if (!jsonString) {
                // Check if it's an excalidraw file that needs decompression
                if (mdContent.includes("excalidraw-plugin: parsed") || mdContent.includes("# Excalidraw Data")) {
                    return { skipped: true, reason: 'Empty drawing - no elements' };
                }
                return { skipped: true, reason: 'No Excalidraw JSON data found' };
            }

            let sceneData = JSON.parse(jsonString);
            if (!sceneData.elements || sceneData.elements.length === 0) {
                return { skipped: true, reason: 'Empty drawing - no elements' };
            }
            
            return { sceneData };
        },

        /**
         * Fix SVG dimensions for saved files
         */
        fixSVGDimensions: (svgElement) => {
            const viewBox = svgElement.getAttribute('viewBox');
            if (!viewBox) {
                console.warn('[SVGConverter] No viewBox found in SVG');
                return svgElement;
            }
            
            const [x, y, width, height] = viewBox.split(' ').map(Number);
            
            // Set explicit width/height for saved files
            svgElement.setAttribute('width', width);
            svgElement.setAttribute('height', height);
            
            return svgElement;
        },

        /**
         * Embed fonts in SVG for proper display
         */
        embedFontsInSvg: (svgElement, fontData, elements) => {
            try {
                if (!svgElement || !fontData) {
                    return svgElement;
                }

                // Find which font families are actually used
                const usedFonts = new Set();
                if (elements && Array.isArray(elements)) {
                    elements.filter(el => el && el.type === 'text').forEach(el => {
                        if (el.fontFamily) {
                            usedFonts.add(el.fontFamily);
                        }
                    });
                }

                if (usedFonts.size === 0) {
                    return svgElement;
                }

                // Create a <defs> section if it doesn't exist
                let defs = svgElement.querySelector('defs');
                if (!defs) {
                    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                    svgElement.insertBefore(defs, svgElement.firstChild);
                }

                // Create a <style> element for @font-face rules
                const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
                style.setAttribute('type', 'text/css');

                // Convert font data to base64
                const base64 = btoa(String.fromCharCode(...new Uint8Array(fontData)));
                
                // Add @font-face rule
                style.textContent = `
@font-face {
    font-family: 'Futura-CondensedLight';
    src: url(data:font/otf;base64,${base64}) format('opentype');
    font-weight: normal;
    font-style: normal;
}
text {
    font-family: 'Futura-CondensedLight', 'Helvetica Neue Condensed', 'Arial Narrow', sans-serif !important;
}
`;
                
                defs.appendChild(style);
                
                return svgElement;
            } catch (error) {
                console.error('[SVGConverter] Error embedding fonts:', error);
                return svgElement;
            }
        },

        /**
         * Generate SVG preview with enhanced conversion logic
         */
        generateSVGPreview: async (sceneData, ExcalidrawModule, fontData, log) => {
            if (log) {
                log('🚀 Starting SVG generation with enhanced logic');
            }

            // Create a working copy to avoid mutating the original
            const workingSceneData = {
                ...sceneData,
                elements: sceneData.elements ? JSON.parse(JSON.stringify(sceneData.elements)) : [],
                files: sceneData.files || {},
                appState: sceneData.appState || {}
            };

            // Filter out deleted elements
            if (workingSceneData.elements && workingSceneData.elements.length > 0) {
                const originalCount = workingSceneData.elements.length;
                workingSceneData.elements = workingSceneData.elements.filter(el => el.isDeleted !== true);
                const deletedCount = originalCount - workingSceneData.elements.length;
                
                if (log && deletedCount > 0) {
                    log(`   🧹 Filtered out ${deletedCount} deleted elements`);
                }
            }

            // Export configuration
            const exportConfig = {
                elements: workingSceneData.elements,
                appState: {
                    ...workingSceneData.appState,
                    exportBackground: false,
                    viewBackgroundColor: 'transparent',
                    exportScale: EXPORT_SCALE,
                    exportEmbedScene: false
                },
                files: workingSceneData.files || {},
                exportPadding: EXPORT_PADDING,
                getFontData: async () => fontData
            };

            if (log) {
                log(`   📊 Exporting ${workingSceneData.elements.length} elements`);
            }

            // Export SVG
            let finalSvg = await ExcalidrawModule.exportToSvg(exportConfig);

            // Embed fonts
            if (fontData) {
                finalSvg = Core.Converter.embedFontsInSvg(finalSvg, fontData, workingSceneData.elements);
            }

            // Fix dimensions for saved file
            finalSvg = Core.Converter.fixSVGDimensions(finalSvg);

            const svgString = new XMLSerializer().serializeToString(finalSvg);

            if (!svgString || svgString.length < 200) {
                throw new Error("Generated SVG is invalid or too small.");
            }

            return { svgString };
        },

        /**
         * Process a single file with the library (with yield points for smooth performance)
         */
        processFileWithLibrary: async (filePath, ExcalidrawModule, LZString, fontData, log) => {
            try {
                const fileName = filePath.split('/').pop();
                
                // Yield before heavy parsing operation
                await new Promise(resolve => setTimeout(resolve, 0));
                
                // Parse Excalidraw data
                const parseResult = await Core.Converter.parseExcalidrawData(filePath, LZString, log);
                
                if (parseResult.skipped) {
                    log(`⊘ Skipped: ${fileName} - ${parseResult.reason}`);
                    return { success: true, skipped: true, filePath };
                }

                const { sceneData } = parseResult;

                // Yield before SVG generation
                await new Promise(resolve => setTimeout(resolve, 0));

                // Generate SVG with enhanced logic
                const { svgString } = await Core.Converter.generateSVGPreview(
                    sceneData,
                    ExcalidrawModule,
                    fontData,
                    log
                );

                // Yield before file write
                await new Promise(resolve => setTimeout(resolve, 0));

                // Save to file
                const svgPath = filePath.replace(/\.md$/i, '.svg');
                await dc.app.vault.adapter.write(svgPath, svgString);
                
                log(`✔ Converted: ${fileName}`);
                return { success: true, filePath };

            } catch (error) {
                const fileName = filePath.split('/').pop();
                log(`❌ FAIL: ${fileName} - ${error.message}`);
                console.error(`Excalidraw Error on file ${filePath}:`, error);
                return { success: false, error: error.message, filePath };
            }
        },

        loadLegacyScript: async (url, globalName, baseDir = null) => {
            if (window[globalName]) { return; }
            
            let scriptContent = null;
            let localCachePath = null;
            
            if (baseDir) {
                const fileName = url.split('/').pop() || `${globalName}.js`;
                localCachePath = `${baseDir}/data/cache/${fileName}`;
                
                try {
                    if (await dc.app.vault.adapter.exists(localCachePath)) {
                        scriptContent = await dc.app.vault.adapter.read(localCachePath);
                    }
                } catch (e) {
                    console.warn(`[Assets Library] Failed to read cached script ${fileName}:`, e);
                }
            }
            
            if (!scriptContent) {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                    scriptContent = await response.text();
                    
                    if (localCachePath) {
                        try {
                            const cacheDir = localCachePath.substring(0, localCachePath.lastIndexOf("/"));
                            const dirParts = cacheDir.split('/');
                            let currentPath = '';
                            for (const part of dirParts) {
                                if (!part) continue;
                                currentPath = currentPath ? `${currentPath}/${part}` : part;
                                if (!(await dc.app.vault.adapter.exists(currentPath))) {
                                    await dc.app.vault.adapter.mkdir(currentPath);
                                }
                            }
                            await dc.app.vault.adapter.write(localCachePath, scriptContent);
                        } catch (e) {
                            console.warn(`[Assets Library] Failed to write cache for ${localCachePath}:`, e);
                        }
                    }
                } catch (e) {
                    throw new Error(`Failed to fetch script from CDN ${url}: ${e.message}`);
                }
            }
            
            return new Promise((resolve, reject) => {
                try {
                    const blob = new Blob([scriptContent], { type: 'application/javascript' });
                    const blobUrl = URL.createObjectURL(blob);
                    const script = document.createElement('script');
                    script.src = blobUrl;
                    script.async = true;
                    script.onload = () => {
                        URL.revokeObjectURL(blobUrl);
                        if (window[globalName]) {
                            resolve();
                        } else {
                            reject(new Error(`Script loaded but global '${globalName}' not found.`));
                        }
                    };
                    script.onerror = () => {
                        URL.revokeObjectURL(blobUrl);
                        reject(new Error(`Failed to load script from blob URL.`));
                    };
                    document.head.appendChild(script);
                } catch (e) {
                    reject(e);
                }
            });
        }
    }
};

// --- 2. Custom Hooks ---

/**
 * A hook to manage the web worker for image rasterization.
 */
const useImageWorker = (imagesToDisplay, onCacheUpdate) => {
    const [worker, setWorker] = useState(null);
    const [error, setError] = useState(null);
    const requestedRef = useRef(new Set());

    useEffect(() => {
        let workerInstance;
        try {
            const src = `self.onmessage = ${Core.imageWorkerCode.toString()}`;
            const blob = new Blob([src], { type: 'application/javascript' });
            workerInstance = new Worker(URL.createObjectURL(blob));
            setWorker(workerInstance);
        } catch (err) {
            console.error("Worker Initialization Failed:", err);
            setError(err.message);
        }
        return () => { if (workerInstance) workerInstance.terminate(); };
    }, []);

    const rasterizeInMain = useCallback((svgText, targetWidth, targetHeight) => {
        const W = 240, H = 300;
        return new Promise((resolve) => { const w = targetWidth || W, h = targetHeight || H; const img = new Image(); const blob = new Blob([svgText], { type: 'image/svg+xml' }); const url = URL.createObjectURL(blob); img.decoding = 'async'; img.onload = async () => { const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d'); const iw = Math.max(1, img.naturalWidth || 1), ih = Math.max(1, img.naturalHeight || 1); const s = Math.min(w / iw, h / ih); const dw = Math.max(1, Math.round(iw * s)), dh = Math.max(1, Math.round(ih * s)); const dx = Math.floor((w - dw) / 2), dy = Math.floor((h - dh) / 2); ctx.clearRect(0, 0, w, h); ctx.drawImage(img, dx, dy, dw, dh); URL.revokeObjectURL(url); const bmp = await createImageBitmap(c); resolve(bmp); }; img.onerror = () => { URL.revokeObjectURL(url); resolve(null); }; img.src = url; });
    }, []);

    useEffect(() => {
        if (!worker) return;
        const filesMap = new Map(imagesToDisplay.map(f => [f.path, f]));

        worker.onmessage = async (e) => {
            const { type, results, fallback } = e.data || {};
            if (type !== 'generated') return;
            let updated = false;

            if (results) {
                for (const path in results) {
                    const { bitmap, isHires } = results[path] || {};
                    if (!bitmap) continue;
                    const file = filesMap.get(path);
                    if (!file) continue;
                    const entry = Core.globalImageCache.get(path) || {};
                    if (isHires) { entry.hiresBitmap = bitmap; entry.hiresRequested = false; }
                    else { entry.bitmap = bitmap; entry.error = false; requestedRef.current.delete(path); }
                    entry.mtime = file.stat.mtime;
                    Core.globalImageCache.set(path, entry);
                    updated = true;
                }
            }

            if (fallback && fallback.length) {
                for (const { path, svgText, isHires } of fallback) {
                    const file = filesMap.get(path);
                    if (!file) continue;
                    const bmp = await rasterizeInMain(svgText, isHires ? 1000 : 240, isHires ? 1250 : 300);
                    const entry = Core.globalImageCache.get(path) || {};
                    if (isHires) { entry.hiresBitmap = bmp; entry.hiresRequested = false; }
                    else { entry.bitmap = bmp; entry.error = !bmp; requestedRef.current.delete(path); }
                    entry.mtime = file.stat.mtime;
                    Core.globalImageCache.set(path, entry);
                    updated = true;
                }
            }
            if (updated) onCacheUpdate();
        };
        return () => { if (worker) worker.onmessage = null; };
    }, [worker, imagesToDisplay, rasterizeInMain, onCacheUpdate]);

    const requestImages = useCallback((filesToLoad, isHires = false) => {
        if (!worker || filesToLoad.length === 0) return;

        const newLoads = filesToLoad.filter(f => !requestedRef.current.has(f.path));
        if (newLoads.length === 0) return;

        for (const f of newLoads) requestedRef.current.add(f.path);

        const fetchAndPost = async () => {
            const data = await Promise.all(newLoads.map(async f => ({
                path: f.path, svgText: await dc.app.vault.read(f), isHires,
                targetWidth: isHires ? 1000 : undefined,
                targetHeight: isHires ? 1250 : undefined,
            })));
            if (worker) worker.postMessage({ type: 'generate', imagesToLoad: data });
        };

        if ('requestIdleCallback' in window && !isHires) {
            window.requestIdleCallback(fetchAndPost, { timeout: 300 });
        } else {
            setTimeout(fetchAndPost, isHires ? 0 : 50);
        }
    }, [worker]);

    return { imageCache: Core.globalImageCache, requestImages, workerError: error, requestedSet: requestedRef.current };
};

/**
 * A hook that manages the rendering and interaction logic for the Grid View canvas.
 */
const useInteractiveCanvas = ({ containerRef, canvasRef, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, resetViewKey, isTransitioning, initialPositions, onTransitionEnd }, isFullTab, onCardClick, imagesToDisplay, isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection, isLightMode) => {
    const cameraState = useRef({ camX: 0, camY: 0, vX: 0, vY: 0, zoom: 1, zTarget: 1 });
    const stateRef = useRef({ isSearching, matchingImagePaths, isSelectionMode, selectedPaths }).current;
    Object.assign(stateRef, { isSearching, matchingImagePaths, isSelectionMode, selectedPaths });

    const gridItemsRef = useRef([]);
    const hoveredTileRef = useRef(null);
    const startTimeRef = useRef(performance.now());

    const imagesToDisplayRef = useRef(imagesToDisplay);
    useEffect(() => {
        imagesToDisplayRef.current = imagesToDisplay;
    }, [imagesToDisplay]);


    const canvasSizeRef = useRef({ CW: 1, CH: 1 });
    const worldFromScreen = useCallback((sx, sy) => {
        const { camX, camY, zoom } = cameraState.current;
        const { CW, CH } = canvasSizeRef.current;
        if (zoom === 0 || CW === 0 || CH === 0) return { x: camX, y: camY };
        return { x: (sx - CW / 2) / zoom + camX, y: (sy - CH / 2) / zoom + camY };
    }, []);

    const requestRender = useCallback(() => { onCacheUpdate.current(); }, [onCacheUpdate]);

    useEffect(() => {
        if (isTransitioning && initialPositions) {
            gridItemsRef.current.forEach(item => {
                const pos = initialPositions.get(item.path);
                if (pos) {
                    item.animX = pos.x; item.animY = pos.y;
                    item.vx = (Math.random() - 0.5) * 20;
                    item.vy = (Math.random() - 0.5) * 20;
                    item.usePhysics = true;
                }
            });
            requestRender();
        }
    }, [isTransitioning, initialPositions, requestRender]);

    useEffect(() => {
        const CARD_W = 160, CARD_H = 200, GAP = 80, TILE_W = CARD_W + GAP, TILE_H = CARD_H + GAP;
        const cols = Math.max(1, Math.ceil(Math.sqrt(imagesToDisplay.length)));

        const gridW = cols * TILE_W;
        const gridH = Math.ceil(imagesToDisplay.length / cols) * TILE_H;

        const oldItemsByPath = new Map(gridItemsRef.current.map(item => [item.path, item]));
        const oldItemPositions = new Map(gridItemsRef.current.map((item, index) => [item.path, index]));

        const newGridItems = imagesToDisplay.map((file, i) => {
            const targetI = i % cols;
            const targetJ = Math.floor(i / cols);
            const targetX = targetI * TILE_W + GAP / 2;
            const targetY = targetJ * TILE_H + GAP / 2;
            const oldItem = oldItemsByPath.get(file.path);

            const needsToAnimateIn = !oldItem || oldItemPositions.get(file.path) !== i;

            if (oldItem) {
                oldItem.targetX = targetX;
                oldItem.targetY = targetY;

                // Keep items that just need repositioning (already loaded)
                if (!needsToAnimateIn) {
                    // Item already in correct position, just update position smoothly
                    return oldItem;
                }
                
                // Item needs to move to new position
                const spawnSide = Math.floor(Math.random() * 4);
                switch (spawnSide) {
                    case 0: oldItem.animX = Math.random() * gridW; oldItem.animY = -CARD_H * 2; break;
                    case 1: oldItem.animX = gridW + CARD_W * 2; oldItem.animY = Math.random() * gridH; break;
                    case 2: oldItem.animX = Math.random() * gridW; oldItem.animY = gridH + CARD_H * 2; break;
                    default: oldItem.animX = -CARD_W * 2; oldItem.animY = Math.random() * gridH; break;
                }
                oldItem.scale = 0;
                oldItem.isActivated = false;
                return oldItem;
            } else {
                // New item - spawn with staggered delay for smooth appearance
                let spawnX, spawnY;
                const spawnSide = Math.floor(Math.random() * 4);
                switch (spawnSide) {
                    case 0: spawnX = Math.random() * gridW; spawnY = -CARD_H * 2; break;
                    case 1: spawnX = gridW + CARD_W * 2; spawnY = Math.random() * gridH; break;
                    case 2: spawnX = Math.random() * gridW; spawnY = gridH + CARD_H * 2; break;
                    default: spawnX = -CARD_W * 2; spawnY = Math.random() * gridH; break;
                }

                return {
                    path: file.path, targetX, targetY,
                    animX: spawnX, animY: spawnY,
                    scale: 0,
                    isActivated: false,
                    spawnDelay: i * 2, // Stagger spawn by 2ms per item for smooth cascade
                    vx: 0, vy: 0, // Velocity for physics
                    isDragging: false, // Dragging state
                };
            }
        });
        const newPaths = new Set(imagesToDisplay.map(f => f.path));
        gridItemsRef.current = newGridItems.filter(item => newPaths.has(item.path));
        requestRender();
    }, [imagesToDisplay, requestRender]);

    useEffect(() => {
        if (!stateRef.prevIsSearching && isSearching && matchingImagePaths.size > 0) {
            const CARD_W = 160, CARD_H = 200, GAP = 80, TILE_W = CARD_W + GAP, TILE_H = CARD_H + GAP;
            const cols = Math.max(1, Math.ceil(Math.sqrt(imagesToDisplay.length)));
            const pathToIndexMap = new Map(imagesToDisplay.map((f, i) => [f.path, i]));
            let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;
            matchingImagePaths.forEach(path => {
                const index = pathToIndexMap.get(path);
                if (index !== undefined) {
                    const i = index % cols; const j = Math.floor(index / cols);
                    minI = Math.min(minI, i); maxI = Math.max(maxI, i);
                    minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j);
                }
            });
            if (isFinite(minI)) {
                const PADDING = 120;
                const resultsLeft = minI * TILE_W; const resultsTop = minJ * TILE_H;
                const resultsWidth = (maxI - minI + 1) * TILE_W; const resultsHeight = (maxJ - minJ + 1) * TILE_H;
                const canvas = canvasRef.current;
                if (cameraState.current && canvas) {
                    const CW = canvas.clientWidth, CH = canvas.clientHeight;
                    const zoomX = CW / (resultsWidth + PADDING); const zoomY = CH / (resultsHeight + PADDING);
                    cameraState.current.zTarget = Math.min(zoomX, zoomY, 3.0);
                    cameraState.current.camX = resultsLeft + resultsWidth / 2;
                    cameraState.current.camY = resultsTop + resultsHeight / 2;
                    interactingUntilRef.current = performance.now() + 400; requestRender();
                }
            }
        } else if (stateRef.prevIsSearching && !isSearching) {
            if (cameraState.current) { cameraState.current.zTarget = 1.0; interactingUntilRef.current = performance.now() + 400; requestRender(); }
        }
        stateRef.prevIsSearching = isSearching;
    }, [isSearching, matchingImagePaths, imagesToDisplay, stateRef, canvasRef, interactingUntilRef, requestRender]);

    useEffect(() => {
        if (resetViewKey > 0 && cameraState.current) {
            const CARD_W = 160, CARD_H = 200, GAP = 80, TILE_W = CARD_W + GAP, TILE_H = CARD_H + GAP;
            const { CW, CH } = canvasSizeRef.current;
            const numImages = imagesToDisplay.length;
            if (numImages === 0 || CW <= 1 || CH <= 1) return;
            const cols = Math.max(1, Math.ceil(Math.sqrt(numImages)));
            const rows = Math.ceil(numImages / cols);
            const gridW = cols * TILE_W; const gridH = rows * TILE_H;
            const PADDING = 80;

            const baseZoom = Math.min(CW / (gridW + PADDING), CH / (gridH + PADDING));
            const targetZoom = Math.min(baseZoom * 1.2, 1.0);

            cameraState.current.camX = gridW / 2; cameraState.current.camY = gridH / 2;
            cameraState.current.zTarget = targetZoom;
            interactingUntilRef.current = performance.now() + 400; requestRender();
        }
    }, [resetViewKey, imagesToDisplay.length, requestRender, interactingUntilRef]);

    useEffect(() => {
        const root = containerRef.current, canvas = canvasRef.current; if (!canvas || !root) return;
        const ctx = canvas.getContext('2d', { alpha: false });
        const back = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
        const bctx = back.getContext('2d', { alpha: false });

        let rafId = 0, running = false, CW = 1, CH = 1, DPR = 1;
        const CARD_W = 160, CARD_H = 200, GAP = 80, TILE_W = CARD_W + GAP, TILE_H = CARD_H + GAP;
        let hoverAnimState = { i: -1, j: -1, strength: 0 };

        let mx = 0, my = 0, dragging = false, dragPointerId = null, panKeyActive = false;
        let anchorWorld = { x: 0, y: 0 }, zoomAnchorWorld = null, zoomAnchorScreen = null;
        let zoomActiveUntil = 0, clickSuppressUntil = 0, dragAccum = 0;

        const internalRequestRender = () => { if (!running) { running = true; rafId = requestAnimationFrame(frame); } };
        onCacheUpdate.current = internalRequestRender;

        const frame = () => {
            const now = performance.now();
            const { camX, camY, vX, vY, zoom, zTarget } = cameraState.current;
            let nextVX = vX, nextVY = vY, nextCamX = camX, nextCamY = camY, nextZoom = zoom;

            const hovered = hoveredTileRef.current?.over ? hoveredTileRef.current : null;
            if (hovered && (hovered.i !== hoverAnimState.i || hovered.j !== hoverAnimState.j)) {
                hoverAnimState.i = hovered.i; hoverAnimState.j = hovered.j;
            }
            const targetStrength = hovered ? 1 : 0;
            hoverAnimState.strength += (targetStrength - hoverAnimState.strength) * 0.15;

            const currentCols = Math.max(1, Math.ceil(Math.sqrt(gridItemsRef.current.length)));
            const currentGridW = currentCols * TILE_W;
            const currentGridH = Math.ceil(gridItemsRef.current.length / currentCols) * TILE_H;

            let isStillAnimating = false;
            const toLoadLowRes = [];
            const localImagesToDisplay = imagesToDisplayRef.current;

            // Progressive loading: only request visible items first, then expand outward
            const camState = cameraState.current;
            const halfW = CW / (2 * camState.zoom), halfH = CH / (2 * camState.zoom);
            const viewBounds = { 
                left: camState.camX - halfW - 500, 
                right: camState.camX + halfW + 500, 
                top: camState.camY - halfH - 500, 
                bottom: camState.camY + halfH + 500 
            };

            // Only request images that aren't already cached or requested (prevents duplicate rendering)
            gridItemsRef.current.forEach((item, index) => {
                // Check if item is near viewport for priority loading
                const isNearViewport = item.targetX >= viewBounds.left && 
                                      item.targetX <= viewBounds.right && 
                                      item.targetY >= viewBounds.top && 
                                      item.targetY <= viewBounds.bottom;

                // Respect spawn delay for smooth cascade effect
                const spawnTime = startTimeRef.current + (item.spawnDelay || 0);
                const canSpawn = now >= spawnTime;
                
                if (!imageCache.has(item.path) && !requestedSet.has(item.path) && isNearViewport && canSpawn) {
                    const file = localImagesToDisplay.find(f => f.path === item.path);
                    if (file) toLoadLowRes.push({ file, priority: isNearViewport ? 0 : 1 });
                }

                if (!item.isActivated && imageCache.has(item.path) && canSpawn) {
                    item.isActivated = true;
                }

                if (item.isActivated) {
                    // Apply physics if item has velocity (from being thrown)
                    if (!item.isDragging && (Math.abs(item.vx) > 0.1 || Math.abs(item.vy) > 0.1)) {
                        // Apply velocity
                        item.animX += item.vx;
                        item.animY += item.vy;
                        
                        // Apply friction
                        item.vx *= 0.92;
                        item.vy *= 0.92;
                        
                        // Spring back towards target with reduced strength while flying
                        const springStrength = 0.01;
                        item.vx += (item.targetX - item.animX) * springStrength;
                        item.vy += (item.targetY - item.animY) * springStrength;
                        
                        // Stop when velocity is very small and near target
                        if (Math.abs(item.vx) < 0.5 && Math.abs(item.vy) < 0.5 && 
                            Math.abs(item.targetX - item.animX) < 5 && Math.abs(item.targetY - item.animY) < 5) {
                            item.vx = 0;
                            item.vy = 0;
                        }
                        
                        isStillAnimating = true;
                    } 
                    // Normal spring animation when not being thrown or dragged
                    else if (!item.isDragging) {
                        item.animX += (item.targetX - item.animX) * 0.08;
                        item.animY += (item.targetY - item.animY) * 0.08;
                    }
                    
                    item.scale += (1 - item.scale) * 0.08;
                }

                if ((item.isActivated && item.scale < 0.99) || Math.abs(item.targetX - item.animX) > 0.1 || Math.abs(item.targetY - item.animY) > 0.1 || !canSpawn || item.isDragging) {
                    isStillAnimating = true;
                }
            });

            // Collision detection: check if dragged or moving items collide with other items
            gridItemsRef.current.forEach((item, idx) => {
                // Only check collisions for items being dragged or with significant velocity
                if (item.isActivated && (item.isDragging || Math.abs(item.vx) > 1 || Math.abs(item.vy) > 1)) {
                    const itemCenterX = item.animX + CARD_W / 2;
                    const itemCenterY = item.animY + CARD_H / 2;
                    
                    gridItemsRef.current.forEach((other, otherIdx) => {
                        if (idx === otherIdx || !other.isActivated || other.isDragging) return;
                        
                        const otherCenterX = other.animX + CARD_W / 2;
                        const otherCenterY = other.animY + CARD_H / 2;
                        
                        // Check collision (using card dimensions for bounding box)
                        const dx = itemCenterX - otherCenterX;
                        const dy = itemCenterY - otherCenterY;
                        const distance = Math.sqrt(dx * dx + dy * dy);
                        const minDist = (CARD_W + CARD_H) / 3; // Collision threshold
                        
                        if (distance < minDist && distance > 0) {
                            // Collision detected! Transfer momentum
                            const overlap = minDist - distance;
                            const force = overlap / minDist; // Normalized collision force
                            
                            // Direction from item to other
                            const nx = dx / distance;
                            const ny = dy / distance;
                            
                            // Calculate relative velocity (how fast they're approaching)
                            const relVx = item.vx - (other.vx || 0);
                            const relVy = item.vy - (other.vy || 0);
                            const approachSpeed = -(relVx * nx + relVy * ny);
                            
                            if (approachSpeed > 0) {
                                // They're moving towards each other - apply impulse
                                const impulseMagnitude = approachSpeed * force * 0.8; // 0.8 = elasticity
                                
                                // Push the other item away based on collision force
                                other.vx = other.vx || 0;
                                other.vy = other.vy || 0;
                                other.vx -= nx * impulseMagnitude;
                                other.vy -= ny * impulseMagnitude;
                                
                                // If being dragged, apply stronger force based on drag velocity
                                if (item.isDragging) {
                                    const dragForce = Math.sqrt(item.vx * item.vx + item.vy * item.vy) * 0.3;
                                    other.vx -= nx * dragForce;
                                    other.vy -= ny * dragForce;
                                }
                                
                                // Separate items to prevent sticking
                                const separation = overlap * 0.5;
                                other.animX -= nx * separation;
                                other.animY -= ny * separation;
                            }
                        }
                    });
                }
            });

            // Batch load with priority - load visible items first (max 16 at once for smooth performance)
            if (toLoadLowRes.length > 0) {
                toLoadLowRes.sort((a, b) => a.priority - b.priority);
                const filesToLoad = toLoadLowRes.slice(0, 16).map(item => item.file);
                requestImages(filesToLoad, false);
            }

            nextVX *= 0.9; nextVY *= 0.9; nextCamX += nextVX; nextCamY += nextVY; nextZoom += (zTarget - nextZoom) * 0.40;
            if (zoomAnchorWorld && (now < zoomActiveUntil || Math.abs(zTarget - nextZoom) > 1e-3)) { nextCamX = zoomAnchorWorld.x - (zoomAnchorScreen.x - CW / 2) / nextZoom; nextCamY = zoomAnchorWorld.y - (zoomAnchorScreen.y - CH / 2) / nextZoom; } else { zoomAnchorWorld = null; zoomAnchorScreen = null; }
            const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
            nextCamX = clamp(nextCamX, -CW, currentGridW + CW); nextCamY = clamp(nextCamY, -CH, currentGridH + CH);
            cameraState.current = { camX: nextCamX, camY: nextCamY, vX: nextVX, vY: nextVY, zoom: nextZoom, zTarget };
            drawFrame();

            // Check if any items have velocity (for collision physics)
            const hasMovingItems = gridItemsRef.current.some(item => Math.abs(item.vx || 0) > 0.1 || Math.abs(item.vy || 0) > 0.1);
            const moving = isStillAnimating || hasMovingItems || Math.abs(nextVX) > 0.01 || Math.abs(nextVY) > 0.01 || Math.abs(zTarget - nextZoom) > 0.001 || hoverAnimState.strength > 0.01 || (hovered && !stateRef.isSelectionMode);
            if (moving) rafId = requestAnimationFrame(frame); else running = false;
        };

        const drawFrame = () => {
            const now = performance.now();
            
            // Look up Obsidian theme color variables dynamically
            const bodyStyles = getComputedStyle(document.body);
            const backgroundPrimary = bodyStyles.getPropertyValue('--background-primary').trim() || '#0f0a12';

            bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, back.width, back.height); bctx.setTransform(DPR, 0, 0, DPR, 0, 0); bctx.fillStyle = backgroundPrimary; bctx.fillRect(0, 0, CW, CH);
            const { camX, camY, zoom } = cameraState.current;
            const halfW = CW / (2 * zoom), halfH = CH / (2 * zoom); const view = { left: camX - halfW, right: camX + halfW, top: camY - halfH, bottom: camY + halfH };
            bctx.save(); bctx.translate(CW / 2, CH / 2); bctx.scale(zoom, zoom); bctx.translate(-camX, -camY);
            const toLoadHighRes = [], visibleHiresPaths = new Set();
            let hoveredItemToRedraw = null;
            const currentCols = Math.max(1, Math.ceil(Math.sqrt(gridItemsRef.current.length)));
            const localImagesToDisplay = imagesToDisplayRef.current;

            gridItemsRef.current.forEach((item) => {
                const { animX, animY, scale } = item;
                if (scale < 0.01) return;

                if (animX < view.left - (CARD_W * scale) || animX > view.right + (CARD_W * scale) || animY < view.top - (CARD_H * scale) || animY > view.bottom + (CARD_H * scale)) return;
                const file = localImagesToDisplay.find(f => f.path === item.path);
                if (!file) return;
                let entry = imageCache.get(item.path);
                if (entry && entry.mtime !== file.stat.mtime) { imageCache.delete(item.path); entry = undefined; }
                let pushX = 0, pushY = 0;
                if (hoverAnimState.strength > 0.01) {
                    const hovI = hoverAnimState.i, hovJ = hoverAnimState.j;
                    const idx = localImagesToDisplay.findIndex(f => f.path === item.path);
                    if (idx === -1) return;
                    const i = idx % currentCols, j = Math.floor(idx / currentCols);
                    const dx = i - hovI, dy = j - hovJ;
                    const distSq = dx * dx + dy * dy;
                    if (distSq > 0 && distSq < 16) { const dist = Math.sqrt(distSq); const maxPush = 50; const power = maxPush * hoverAnimState.strength; const pushAmount = power / (distSq + 0.5); pushX = (dx / dist) * pushAmount; pushY = (dy / dist) * pushAmount; }
                }
                const x = animX + pushX; const y = animY + pushY;
                const idx = localImagesToDisplay.findIndex(f => f.path === item.path);
                if (idx === -1) return;
                const i = idx % currentCols, j = Math.floor(idx / currentCols);
                const isHovered = hoveredTileRef.current && hoveredTileRef.current.i === i && hoveredTileRef.current.j === j && hoveredTileRef.current.over;
                const isSelected = stateRef.selectedPaths.has(item.path);
                const hoverScale = isHovered ? Math.min(2.5, 1.0 + 0.2 / zoom) : 1.0;
                const finalScale = scale * hoverScale;
                const drawW = CARD_W * finalScale; const drawH = CARD_H * finalScale;
                const drawX = x - (drawW - CARD_W) / 2; const drawY = y - (drawH - CARD_H) / 2;
                const drawPayload = { file, path: item.path, entry, item, x, y, drawX, drawY, drawW, drawH, isHovered, isSelected };
                if (isHovered) hoveredItemToRedraw = drawPayload; else drawCard(drawPayload);
            });
            if (hoveredItemToRedraw) drawCard(hoveredItemToRedraw);
            function drawCard({ file, path, entry, item, x, y, drawX, drawY, drawW, drawH, isHovered, isSelected }) {
                const isMatch = stateRef.isSearching && stateRef.matchingImagePaths.has(path);
                const isNotMatch = stateRef.isSearching && !isMatch;
                bctx.save();
                if (isNotMatch) { bctx.globalAlpha *= 0.15; }
                const useHires = zoom > 1.4 && entry?.hiresBitmap;
                const bitmapToDraw = useHires ? entry.hiresBitmap : entry?.bitmap;

                if (!bitmapToDraw) {
                    Core.drawPlaceholder(bctx, file, drawX, drawY, drawW, drawH, entry?.error);
                } else {
                    if (isLightMode) bctx.filter = 'invert(1)';
                    bctx.drawImage(bitmapToDraw, drawX, drawY, drawW, drawH);
                    if (isLightMode) bctx.filter = 'none';
                }
                if (useHires) visibleHiresPaths.add(path);

                if (isSelected) { bctx.fillStyle = 'rgba(135, 255, 197, 0.25)'; bctx.fillRect(drawX, drawY, drawW, drawH); bctx.strokeStyle = 'rgba(135, 255, 197, 0.8)'; bctx.lineWidth = 2 / zoom; bctx.strokeRect(drawX, drawY, drawW, drawH); }
                if (isMatch && !isSelected) { bctx.strokeStyle = 'rgba(170, 130, 255, 0.7)'; bctx.lineWidth = 2 / zoom; bctx.strokeRect(drawX - 1, drawY - 1, drawW + 2, drawH + 2); }
                if (isHovered && !stateRef.isSelectionMode && !isSelected) {
                    bctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'; bctx.lineWidth = 1.5 / zoom;
                    const pulse = (Math.sin(now / 300) + 1) / 2;
                    const M_SIZE = (8 + pulse * 6) / zoom; const M_OFFSET = -8 / zoom;
                    bctx.beginPath();
                    bctx.moveTo(drawX + M_OFFSET, drawY + M_OFFSET + M_SIZE); bctx.lineTo(drawX + M_OFFSET, drawY + M_OFFSET); bctx.lineTo(drawX + M_OFFSET + M_SIZE, drawY + M_OFFSET);
                    bctx.moveTo(drawX + drawW - M_OFFSET - M_SIZE, drawY + M_OFFSET); bctx.lineTo(drawX + drawW - M_OFFSET, drawY + M_OFFSET); bctx.lineTo(drawX + drawW - M_OFFSET, drawY + M_OFFSET + M_SIZE);
                    bctx.moveTo(drawX + M_OFFSET, drawY + drawH - M_OFFSET - M_SIZE); bctx.lineTo(drawX + M_OFFSET, drawY + drawH - M_OFFSET); bctx.lineTo(drawX + M_OFFSET + M_SIZE, drawY + drawH - M_OFFSET);
                    bctx.moveTo(drawX + drawW - M_OFFSET - M_SIZE, drawY + drawH - M_OFFSET); bctx.lineTo(drawX + drawW - M_OFFSET, drawY + drawH - M_OFFSET); bctx.lineTo(drawX + drawW - M_OFFSET, drawY + drawH - M_OFFSET - M_SIZE);
                    bctx.stroke();
                }
                if (stateRef.isSelectionMode && isHovered && !isSelected) { bctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'; bctx.lineWidth = 2 / zoom; bctx.beginPath(); bctx.arc(x + CARD_W / 2, y + CARD_H / 2, 30 / zoom, 0, 2 * Math.PI); bctx.stroke(); }
                if (isSelected) { bctx.fillStyle = 'rgba(135, 255, 197, 0.8)'; bctx.beginPath(); bctx.arc(x + CARD_W / 2, y + CARD_H / 2, 30 / zoom, 0, 2 * Math.PI); bctx.fill(); bctx.strokeStyle = '#0f0a12'; bctx.lineWidth = 2.5 / zoom; bctx.beginPath(); bctx.moveTo(x + CARD_W / 2 - 12 / zoom, y + CARD_H / 2); bctx.lineTo(x + CARD_W / 2 - 4 / zoom, y + CARD_H / 2 + 8 / zoom); bctx.lineTo(x + CARD_W / 2 + 12 / zoom, y + CARD_H / 2 - 7 / zoom); bctx.stroke(); }
                bctx.restore();
                if (zoom > 1.4 && entry?.bitmap && !entry.hiresBitmap && !entry.hiresRequested) { entry.hiresRequested = true; toLoadHighRes.push(file); }
            }
            if (toLoadHighRes.length) { requestImages(toLoadHighRes, true); }
            bctx.restore(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(back, 0, 0, canvas.width, canvas.height);
            for (const [path, entry] of imageCache.entries()) { if (entry.hiresBitmap && !visibleHiresPaths.has(path)) { entry.hiresBitmap.close?.(); delete entry.hiresBitmap; entry.hiresRequested = false; } }
        };

        const setInteracting = (duration = 200) => { interactingUntilRef.current = performance.now() + duration; };
        const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
        const getTile = (wx, wy) => {
            const currentCols = Math.max(1, Math.ceil(Math.sqrt(gridItemsRef.current.length)));
            const i = Math.floor(wx / TILE_W), j = Math.floor(wy / TILE_H);
            const localX = wx - i * TILE_W, localY = wy - j * TILE_H;
            const over = localX >= GAP / 2 && localX <= GAP / 2 + CARD_W && localY >= GAP / 2 && localY <= GAP / 2 + CARD_H;
            return { i, j, over };
        };
        const sizeToContainer = () => {
            const r = root.getBoundingClientRect(), dpr = Math.min(1.75, window.devicePixelRatio || 1);
            if (CW !== r.width || CH !== r.height || DPR !== dpr) {
                CW = r.width; CH = r.height; DPR = dpr;
                canvasSizeRef.current = { CW, CH };
                canvas.width = Math.max(1, Math.floor(CW * DPR)); canvas.height = Math.max(1, Math.floor(CH * DPR));
                back.width = canvas.width; back.height = canvas.height;

                if (cameraState.current.camX === 0 && CW > 1 && CH > 1 && gridItemsRef.current.length > 0) {
                    const numImages = gridItemsRef.current.length;
                    const cols = Math.max(1, Math.ceil(Math.sqrt(numImages)));
                    const rows = Math.ceil(numImages / cols);
                    const gridW = cols * TILE_W; const gridH = rows * TILE_H;
                    const PADDING = 80;

                    const baseZoom = Math.min(CW / (gridW + PADDING), CH / (gridH + PADDING));
                    const initialZoom = Math.min(baseZoom * 1.2, 1.0);

                    cameraState.current = {
                        camX: gridW / 2, camY: gridH / 2,
                        vX: 0, vY: 0, zoom: initialZoom, zTarget: initialZoom,
                    };
                }
                internalRequestRender();
            }
        };

        const startDragIfAllowed = (e) => { const allow = e.button === 1 || e.button === 2 || panKeyActive; if (!allow) return false; const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; dragging = true; dragPointerId = e.pointerId; anchorWorld = worldFromScreen(mx, my); cameraState.current.vX = 0; cameraState.current.vY = 0; dragAccum = 0; setInteracting(); canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing'; return true; };
        
        const onPointerDown = (e) => { 
            if (e.target !== canvas || document.querySelector('.panel-wrap') || document.querySelector('.image-gallery-searchbar')?.contains(e.target)) return; 
            if (startDragIfAllowed(e)) { 
                e.preventDefault(); 
                internalRequestRender(); 
            } 
        };
        const onPointerMove = (e) => { 
            const r = canvas.getBoundingClientRect(); 
            const pMx = mx, pMy = my; 
            mx = e.clientX - r.left; 
            my = e.clientY - r.top; 
            
            if (dragging && e.pointerId === dragPointerId) { 
                const { camX: prevX, camY: prevY, zoom } = cameraState.current; 
                let camX = anchorWorld.x - (mx - CW / 2) / zoom; 
                let camY = anchorWorld.y - (my - CH / 2) / zoom; 
                cameraState.current.vX = (camX - prevX) * 0.85; 
                cameraState.current.vY = (camY - prevY) * 0.85; 
                cameraState.current.camX = camX; 
                cameraState.current.camY = camY; 
                dragAccum += Math.hypot(mx - pMx, my - pMy); 
                setInteracting(); 
                internalRequestRender(); 
            } else { 
                const wp = worldFromScreen(mx, my); 
                const hit = getTile(wp.x, wp.y); 
                const old = hoveredTileRef.current; 
                if (hit.i !== old?.i || hit.j !== old?.j || hit.over !== old?.over) { 
                    hoveredTileRef.current = hit; 
                    if (stateRef.isSelectionMode && hit.over) { 
                        canvas.style.cursor = 'pointer'; 
                    } else if (!panKeyActive) { 
                        canvas.style.cursor = 'default'; 
                    } 
                    internalRequestRender(); 
                } 
            } 
        };
        const onPointerUp = (e) => { 
            if (!dragging || e.pointerId !== dragPointerId) return; 
            dragging = false; 
            dragPointerId = null; 
            canvas.releasePointerCapture?.(e.pointerId); 
            canvas.style.cursor = panKeyActive ? 'grab' : (stateRef.isSelectionMode ? 'pointer' : 'default'); 
            clickSuppressUntil = performance.now() + 250; 
            internalRequestRender(); 
        };
        const onPointerLeave = () => { if (hoveredTileRef.current) { hoveredTileRef.current = null; internalRequestRender(); } };
        const onContextMenu = (e) => { e.preventDefault(); };
        const onKeyDown = (e) => { if (e.code === 'Space') { if (!panKeyActive) { panKeyActive = true; if (!dragging) canvas.style.cursor = 'grab'; } } if (e.key === '+' || e.key === '=') { const cx = CW / 2, cy = CH / 2; zoomAnchorScreen = { x: cx, y: cy }; zoomAnchorWorld = worldFromScreen(cx, cy); cameraState.current.zTarget = clamp(cameraState.current.zoom * 1.8, 0.1, 5); zoomActiveUntil = performance.now() + 300; setInteracting(); internalRequestRender(); } if (e.key === '-') { const cx = CW / 2, cy = CH / 2; zoomAnchorScreen = { x: cx, y: cy }; zoomAnchorWorld = worldFromScreen(cx, cy); cameraState.current.zTarget = clamp(cameraState.current.zoom / 1.8, 0.1, 5); zoomActiveUntil = performance.now() + 300; setInteracting(); internalRequestRender(); } };
        const onKeyUp = (e) => { if (e.code === 'Space') { panKeyActive = false; if (!dragging) canvas.style.cursor = stateRef.isSelectionMode ? 'pointer' : 'default'; } };
        const onWheel = (e) => { if (document.querySelector('.panel-wrap') || document.querySelector('.image-gallery-searchbar')?.contains(e.target)) return; const isZoom = e.ctrlKey || e.metaKey; if (isZoom) { e.preventDefault(); const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; const factor = Math.exp(-e.deltaY * 0.0068); const zPrime = clamp(cameraState.current.zoom * factor, 0.1, 5); zoomAnchorScreen = { x: mx, y: my }; zoomAnchorWorld = worldFromScreen(mx, my); cameraState.current.zTarget = zPrime; zoomActiveUntil = performance.now() + 300; setInteracting(); internalRequestRender(); } else { e.preventDefault(); const k = 1 / cameraState.current.zoom; cameraState.current.camX += e.deltaX * k; cameraState.current.camY += e.deltaY * k; cameraState.current.vX = e.deltaX * 0.02 * k; cameraState.current.vY = e.deltaY * 0.02 * k; setInteracting(120); internalRequestRender(); } };
        let gestureLast = 1; const onGestureStart = (e) => { gestureLast = 1; const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; zoomAnchorScreen = { x: mx, y: my }; zoomAnchorWorld = worldFromScreen(mx, my); zoomActiveUntil = performance.now() + 400; }; const onGestureChange = (e) => { const PINCH_SENSITIVITY = 64; const scaleRatio = e.scale / gestureLast; const amplifiedRatio = 2 + (scaleRatio - 1) * PINCH_SENSITIVITY; gestureLast = e.scale; cameraState.current.zTarget = clamp(cameraState.current.zoom * amplifiedRatio, 0.1, 5); setInteracting(); internalRequestRender(); }; const onGestureEnd = () => { zoomActiveUntil = performance.now() + 200; };
        const onClick = async () => {
            if (performance.now() < clickSuppressUntil) return; if (dragAccum > 8) return; const wp = worldFromScreen(mx, my); const hit = getTile(wp.x, wp.y);
            const currentCols = Math.max(1, Math.ceil(Math.sqrt(gridItemsRef.current.length)));
            const idx = hit.j * currentCols + hit.i;
            const localImagesToDisplay = imagesToDisplayRef.current;
            if (!hit.over || idx < 0 || idx >= localImagesToDisplay.length) return;
            const file = localImagesToDisplay[idx];
            if (stateRef.isSelectionMode) { onToggleSelection(file.path); return; }
            if (stateRef.isSearching && !stateRef.matchingImagePaths.has(file.path)) return;
            const cached = imageCache.get(file.path); if (!cached?.bitmap) return;
            const tempCanvas = document.createElement('canvas'); tempCanvas.width = 16; tempCanvas.height = 20; tempCanvas.getContext('2d').drawImage(cached.bitmap, 0, 0, 16, 20);
            const lowResUrl = tempCanvas.toDataURL('image/jpeg', 0.1); const initialBitmap = cached.hiresBitmap || cached.bitmap; onCardClick({ path: file.path, lowResUrl, initialBitmap, i: hit.i, j: hit.j });
        };

        sizeToContainer(); internalRequestRender();
        let resizeRAF = 0; const ro = new ResizeObserver(() => { cancelAnimationFrame(resizeRAF); resizeRAF = requestAnimationFrame(sizeToContainer); }); ro.observe(root);

        canvas.addEventListener('pointerdown', onPointerDown); window.addEventListener('pointermove', onPointerMove, { passive: true }); window.addEventListener('pointerup', onPointerUp); canvas.addEventListener('pointerleave', onPointerLeave); canvas.addEventListener('contextmenu', onContextMenu); window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('gesturestart', onGestureStart); canvas.addEventListener('gesturechange', onGestureChange); canvas.addEventListener('gestureend', onGestureEnd); canvas.addEventListener('click', onClick);
        return () => { ro.disconnect(); onCacheUpdate.current = () => { }; canvas.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp); canvas.removeEventListener('pointerleave', onPointerLeave); canvas.removeEventListener('contextmenu', onContextMenu); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('gesturestart', onGestureStart); canvas.removeEventListener('gesturechange', onGestureChange); canvas.removeEventListener('gestureend', onGestureEnd); canvas.removeEventListener('click', onClick); running = false; cancelAnimationFrame(rafId); };
    }, [isFullTab, onCardClick, onToggleSelection, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, containerRef, canvasRef, onTransitionEnd, isLightMode]);
};




const useGraphCanvas = ({ containerRef, canvasRef, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, resetViewKey, nodesRef: nodesRefProp }, isFullTab, onCardClick, imagesToDisplay, a888aTagsMap, isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection, isLightMode) => {
    const nodesRef = useRef([]);
    const cameraState = useRef({ camX: 0, camY: 0, vX: 0, vY: 0, zoom: 0.08, zTarget: 0.08 });
    const hoveredNodeRef = useRef(null);
    const draggedNodeRef = useRef(null);
    const effectsRef = useRef([]);
    const stateRef = useRef({}).current;
    Object.assign(stateRef, { isSearching, matchingImagePaths, isSelectionMode, selectedPaths, a888aTagsMap });
    const runPhysics = useRef(true);
    const requestRender = useCallback(() => { onCacheUpdate.current(); }, [onCacheUpdate]);
    const debugLoggedRef = useRef(false);

    useEffect(() => {
        const oldNodesByPath = new Map(nodesRef.current.map(node => [node.file.path, node]));
        const R = Math.sqrt(imagesToDisplay.length) * 160;
        const newNodes = imagesToDisplay.map((file, i) => {
            const oldNode = oldNodesByPath.get(file.path);
            if (oldNode) {
                // Keep existing node position, just update scale target
                oldNode.scaleTarget = 1;
                return oldNode;
            }
            // New node - spawn with staggered animation
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.sqrt(imagesToDisplay.length) * 100 * (1 + Math.random());
            return {
                file: file,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                vx: 0, vy: 0, w: 160, h: 160,
                scale: 0, scaleTarget: 1,
                spawnDelay: i * 3, // Stagger by 3ms for smooth cascade
                spawnTime: performance.now() + (i * 3),
            };
        });
        const newPaths = new Set(imagesToDisplay.map(f => f.path));
        nodesRef.current = newNodes.filter(node => newPaths.has(node.file.path));
        if (imagesToDisplay.length > 0) {
            runPhysics.current = true;
            requestRender();
        }
    }, [imagesToDisplay, requestRender]);

    useEffect(() => {
        if (resetViewKey > 0 && cameraState.current) {
            cameraState.current.camX = 0;
            cameraState.current.camY = 0;
            cameraState.current.zTarget = 0.5;
            requestRender();
        }
    }, [resetViewKey, requestRender]);

    useEffect(() => {
        const root = containerRef.current, canvas = canvasRef.current;
        if (!canvas || !root) return;
        const ctx = canvas.getContext('2d', { alpha: false });
        const back = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
        const bctx = back.getContext('2d', { alpha: false });
        let rafId = 0, running = false, CW = 1, CH = 1, DPR = 1;
        const CARD_W = 160, CARD_H = 160;
        let mx = 0, my = 0, dragPointerId = null;
        let clickSuppressUntil = 0, dragAccum = 0;
        let zoomAnchorWorld = null, zoomAnchorScreen = null, zoomActiveUntil = 0;

        const internalRequestRender = () => { if (!running) { running = true; rafId = requestAnimationFrame(frame); } };
        onCacheUpdate.current = internalRequestRender;

        const frame = () => {
            const now = performance.now();
            let { camX, camY, vX, vY, zoom, zTarget } = cameraState.current;
            vX *= 0.9; vY *= 0.9; camX += vX; camY += vY;
            zoom += (zTarget - zoom) * 0.40;
            if (zoomAnchorWorld && (now < zoomActiveUntil || Math.abs(zTarget - zoom) > 1e-3)) {
                camX = zoomAnchorWorld.x - (zoomAnchorScreen.x - CW / 2) / zoom;
                camY = zoomAnchorWorld.y - (zoomAnchorScreen.y - CH / 2) / zoom;
            } else {
                zoomAnchorWorld = null; zoomAnchorScreen = null;
            }
            cameraState.current = { camX, camY, vX, vY, zoom, zTarget };
            const physicsMovement = physicsStep();
            drawFrame();
            if (nodesRefProp) {
                nodesRefProp.current = nodesRef.current;
            }
            const isScaling = nodesRef.current.some(n => Math.abs(n.scale - n.scaleTarget) > 0.01);
            const stillAnimating = physicsMovement > 0.1 || Math.abs(vX) > 0.01 || Math.abs(vY) > 0.01 || Math.abs(zTarget - zoom) > 0.001 || effectsRef.current.length > 0 || isScaling || hoveredNodeRef.current !== null;
            if (stillAnimating) {
                rafId = requestAnimationFrame(frame);
            } else {
                running = false;
            }
        };

        const drawFrame = () => {
            if (!debugLoggedRef.current && nodesRef.current.length > 0 && CW > 1) {
                console.clear();
                console.log("--- GRAPH DEBUG FRAME (ONE-TIME LOG) ---");
                console.log(`Canvas Dimensions: CW = ${CW}, CH = ${CH}`);
                const { camX, camY, zoom } = cameraState.current;
                console.log(`Camera State ("Where I am"): camX = ${camX.toFixed(2)}, camY = ${camY.toFixed(2)}, zoom = ${zoom.toFixed(4)}`);
                const firstNode = nodesRef.current[0];
                if (firstNode) {
                    console.log(`\nFirst Node Details: ${firstNode.file.basename}`);
                    console.log(`World Position: x = ${firstNode.x.toFixed(2)}, y = ${firstNode.y.toFixed(2)}`);
                    const relX = firstNode.x - camX;
                    const relY = firstNode.y - camY;
                    const screenX = (relX * zoom) + (CW / 2);
                    const screenY = (relY * zoom) + (CH / 2);
                    const nodeRadiusOnScreen = (firstNode.w / 2) * zoom;
                    const cornerTopLeftX = screenX - nodeRadiusOnScreen;
                    const cornerTopLeftY = screenY - nodeRadiusOnScreen;
                    const cornerBottomRightX = screenX + nodeRadiusOnScreen;
                    const cornerBottomRightY = screenY + nodeRadiusOnScreen;
                    console.log(`Expected Screen Center: x = ${screenX.toFixed(2)}, y = ${screenY.toFixed(2)}`);
                    console.log(` -> This should be near the middle of your screen [${(CW / 2).toFixed(2)}, ${(CH / 2).toFixed(2)}]`);
                    console.log("\nExpected Screen Corners (Bounding Box):");
                    console.log(` -> Top-Left: [${cornerTopLeftX.toFixed(2)}, ${cornerTopLeftY.toFixed(2)}]`);
                    console.log(` -> Bottom-Right: [${cornerBottomRightX.toFixed(2)}, ${cornerBottomRightY.toFixed(2)}]`);
                    if (CW < 100 || CH < 100) {
                        console.error("!!! CRITICAL: Canvas dimensions are too small or zero. This is likely the cause of the top-left issue. The centering math is failing.");
                    }
                }
                console.log("-----------------------------------------");
                debugLoggedRef.current = true;
            }

            if (CW < 2 || CH < 2) return;
            const now = performance.now();
            
            // Look up Obsidian theme color variables dynamically
            const bodyStyles = getComputedStyle(document.body);
            const backgroundPrimary = bodyStyles.getPropertyValue('--background-primary').trim() || '#0f0a12';
            const accentColor = bodyStyles.getPropertyValue('--interactive-accent').trim() || '#8758FF';
            const textNormal = bodyStyles.getPropertyValue('--text-normal').trim() || '#ffffff';
            const textMuted = bodyStyles.getPropertyValue('--text-muted').trim() || '#9a92b0';

            bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, back.width, back.height);
            bctx.setTransform(DPR, 0, 0, DPR, 0, 0); bctx.fillStyle = backgroundPrimary; bctx.fillRect(0, 0, CW, CH);
            const { camX, camY, zoom } = cameraState.current;
            bctx.save();
            bctx.translate(CW / 2, CH / 2);
            bctx.scale(zoom, zoom);
            bctx.translate(-camX, -camY);
            const toLoadLowRes = [], toLoadHighRes = [], visibleHiresPaths = new Set();
            const halfW = CW / (2 * zoom), halfH = CH / (2 * zoom);
            const view = { left: camX - halfW - CARD_W, right: camX + halfW + CARD_W, top: camY - halfH - CARD_H, bottom: camY + halfH + CARD_H };
            bctx.save();
            bctx.globalCompositeOperation = 'lighter';
            const EFFECT_DURATION = 600;
            effectsRef.current = effectsRef.current.filter(eff => {
                const age = now - eff.startTime;
                if (age > EFFECT_DURATION) return false;
                const { node } = eff;
                if (!node) return false;
                const progress = age / EFFECT_DURATION;
                const baseRadius = (node.w * node.scale / 2);
                const radius = baseRadius + progress * 80;
                const alpha = Math.sin(Math.PI * progress) * 0.5;
                const grad = bctx.createRadialGradient(node.x, node.y, radius * 0.5, node.x, node.y, radius);
                grad.addColorStop(0, `rgba(200, 160, 255, ${alpha})`);
                grad.addColorStop(1, `rgba(200, 160, 255, 0)`);
                bctx.fillStyle = grad;
                bctx.beginPath();
                bctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
                bctx.fill();
                return true;
            });
            bctx.restore();
            nodesRef.current.sort((a, b) => a.scale - b.scale);
            nodesRef.current.forEach(node => {
                // Respect spawn delay for smooth cascade
                const canShow = !node.spawnTime || now >= node.spawnTime;
                if (!canShow) return;
                
                const isHovered = hoveredNodeRef.current === node;
                const hoverScaleFactor = Math.min(8.0, 1.8 + 0.8 / zoom);
                node.scaleTarget = isHovered ? hoverScaleFactor : 1.0;
                node.scale += (node.scaleTarget - node.scale) * 0.2;
                const path = node.file.path;
                let entry = imageCache.get(path);
                if (entry && entry.mtime !== node.file.stat.mtime) {
                    entry.bitmap?.close?.();
                    entry.hiresBitmap?.close?.();
                    imageCache.delete(path);
                    entry = undefined;
                }
                const scaledW = node.w * node.scale;
                // Only render nodes in viewport (with some padding for smooth panning)
                if (node.x < view.left - scaledW || node.x > view.right + scaledW || node.y < view.top - scaledW || node.y > view.bottom + scaledW) return;
                
                const isMatch = stateRef.isSearching && stateRef.matchingImagePaths.has(path);
                const isNotMatch = stateRef.isSearching && !isMatch;
                const isSelected = stateRef.selectedPaths.has(path);
                if (isNotMatch) {
                    bctx.save();
                    bctx.globalAlpha = 0.15;
                }
                const useHires = (zoom > 0.6 || isHovered) && entry?.hiresBitmap;
                const bitmapToDraw = useHires ? entry.hiresBitmap : entry?.bitmap;
                bctx.save();
                bctx.beginPath();
                bctx.arc(node.x, node.y, scaledW / 2, 0, Math.PI * 2);
                bctx.clip();
                if (bitmapToDraw) {
                    if (useHires) visibleHiresPaths.add(path);
                    bctx.imageSmoothingEnabled = zoom > 0.6 * 0.9;
                    const IMAGE_PADDING = 0.9;
                    if (isLightMode) bctx.filter = 'invert(1)';
                    bctx.drawImage(bitmapToDraw, node.x - (scaledW * IMAGE_PADDING) / 2, node.y - (scaledW * IMAGE_PADDING) / 2, scaledW * IMAGE_PADDING, scaledW * IMAGE_PADDING);
                    if (isLightMode) bctx.filter = 'none';
                } else {
                    Core.drawPlaceholder(bctx, node.file, node.x - scaledW / 2, node.y - scaledW / 2, scaledW, scaledW, entry?.error);
                    // Only request if not already cached/requested (prevents duplicate loads)
                    if (!requestedSet.has(path)) toLoadLowRes.push(node.file);
                }
                bctx.restore();
                if ((zoom > 0.6 || isHovered) && entry?.bitmap && !entry.hiresBitmap && !entry.hiresRequested) {
                    entry.hiresRequested = true;
                    toLoadHighRes.push(node.file);
                }
                if (isSelected) {
                    bctx.strokeStyle = 'rgba(135, 255, 197, 0.8)';
                    bctx.lineWidth = 3 / zoom;
                    bctx.beginPath();
                    bctx.arc(node.x, node.y, scaledW / 2, 0, Math.PI * 2);
                    bctx.stroke();
                }
                if (isMatch && !isSelected) {
                    bctx.strokeStyle = accentColor;
                    bctx.lineWidth = 3 / zoom;
                    bctx.beginPath();
                    bctx.arc(node.x, node.y, scaledW / 2, 0, Math.PI * 2);
                    bctx.stroke();
                }
                if (isHovered && !isSelected) {
                    bctx.strokeStyle = textNormal;
                    bctx.lineWidth = 2.5 / zoom;
                    const radius = scaledW / 2 + 5 / zoom;
                    for (let i = 0; i < 8; i++) {
                        const rotation = (now / 2000 + i * 0.1) % (Math.PI * 2);
                        const pulse = (Math.sin(now / 350 + i * 0.7) + 1) / 2;
                        const baseArcLength = Math.PI / 24;
                        const arcLength = baseArcLength * (1 + pulse * 1.5);
                        const angle = rotation + i * (Math.PI / 4);
                        bctx.beginPath();
                        bctx.arc(node.x, node.y, radius, angle - arcLength / 2, angle + arcLength / 2);
                        bctx.stroke();
                    }
                }
                if (isNotMatch) {
                    bctx.restore();
                }
            });
            const hoveredNode = hoveredNodeRef.current;
            if (hoveredNode && hoveredNode.scale > 1.05) {
                const alpha = Math.min(1, (hoveredNode.scale - 1) / 0.4);
                const name = hoveredNode.file.basename.replace('.svg', '');
                const tags = stateRef.a888aTagsMap.get(hoveredNode.file.path);
                
                bctx.save();
                bctx.globalAlpha = alpha;
                bctx.font = `${14 / zoom}px sans-serif`;
                bctx.textAlign = 'center';
                bctx.fillStyle = textNormal;
                bctx.fillText(name, hoveredNode.x, hoveredNode.y + (hoveredNode.h * hoveredNode.scale / 2) + (18 / zoom));
                if (tags && tags.length > 0) {
                    bctx.font = `${12 / zoom}px sans-serif`;
                    bctx.fillStyle = textMuted;
                    bctx.fillText(tags.join(', '), hoveredNode.x, hoveredNode.y + (hoveredNode.h * hoveredNode.scale / 2) + (36 / zoom));
                }
                bctx.restore();
            }
            // Batch load images - limited for performance (prevents duplicate requests)
            if (toLoadLowRes.length) { requestImages(toLoadLowRes.slice(0, 16), false); }
            if (toLoadHighRes.length) { requestImages(toLoadHighRes, true); }
            bctx.restore();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(back, 0, 0, canvas.width, canvas.height);
            // Clean up unused high-res bitmaps to save memory
            for (const [path, entry] of imageCache.entries()) {
                if (entry.hiresBitmap && !visibleHiresPaths.has(path)) {
                    entry.hiresBitmap.close?.();
                    delete entry.hiresBitmap;
                    entry.hiresRequested = false;
                }
            }
        };

        const physicsStep = () => {
            if (!runPhysics.current) return 0;
            const REPULSION = 60000; // Reduced from 80000 for softer repulsion
            const CENTER_PULL = 0.0008; // Reduced from 0.001 for gentler centering
            const DAMPING = 0.92; // Increased from 0.90 for smoother deceleration
            const nodes = nodesRef.current;
            for (let i = 0; i < nodes.length; i++) {
                const n1 = nodes[i];
                if (n1 === draggedNodeRef.current) continue;
                n1.vx -= n1.x * CENTER_PULL;
                n1.vy -= n1.y * CENTER_PULL;
                for (let j = i + 1; j < nodes.length; j++) {
                    const n2 = nodes[j];
                    const dx = n1.x - n2.x;
                    const dy = n1.y - n2.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const combinedRadius = (n1.w * n1.scale / 2) + (n2.w * n2.scale / 2);
                    if (dist < combinedRadius && dist > 0) {
                        const overlap = combinedRadius - dist;
                        const moveX = (overlap / 2) * (dx / dist) * 0.7; // Soften overlap correction
                        const moveY = (overlap / 2) * (dy / dist) * 0.7;
                        n1.x += moveX;
                        n1.y += moveY;
                        n2.x -= moveX;
                        n2.y -= moveY;
                    }
                    if (dist > 0) {
                        const force = REPULSION / (dist * dist + 100); // Added offset to prevent extreme forces
                        const fx = (dx / dist) * force;
                        const fy = (dy / dist) * force;
                        // Cap maximum force to prevent jittery behavior
                        const maxForce = 5.0;
                        n1.vx += Math.max(-maxForce, Math.min(maxForce, fx));
                        n1.vy += Math.max(-maxForce, Math.min(maxForce, fy));
                        n2.vx -= Math.max(-maxForce, Math.min(maxForce, fx));
                        n2.vy -= Math.max(-maxForce, Math.min(maxForce, fy));
                    }
                }
            }
            let totalMovement = 0;
            for (const node of nodes) {
                if (node === draggedNodeRef.current) continue;
                node.vx *= DAMPING;
                node.vy *= DAMPING;
                // Higher cap to allow nodes to FLY when hit hard! 🚀
                const maxVelocity = 25.0;
                node.vx = Math.max(-maxVelocity, Math.min(maxVelocity, node.vx));
                node.vy = Math.max(-maxVelocity, Math.min(maxVelocity, node.vy));
                node.x += node.vx;
                node.y += node.vy;
                totalMovement += Math.abs(node.vx) + Math.abs(node.vy);
            }
            if (totalMovement < 0.1 && !draggedNodeRef.current && !hoveredNodeRef.current) {
                runPhysics.current = false;
            }
            return totalMovement;
        };

        const setInteracting = (duration = 200) => { interactingUntilRef.current = performance.now() + duration; };
        const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
        const worldFromScreen = (sx, sy, z) => { const k = z ?? cameraState.current.zoom; return { x: (sx - CW / 2) / k + cameraState.current.camX, y: (sy - CH / 2) / k + cameraState.current.camY }; };
        const sizeToContainer = () => { const r = root.getBoundingClientRect(), dpr = Math.min(1.75, window.devicePixelRatio || 1); if (CW !== r.width || CH !== r.height || DPR !== dpr) { CW = r.width; CH = r.height; DPR = dpr; canvas.width = Math.max(1, Math.floor(CW * DPR)); canvas.height = Math.max(1, Math.floor(CH * DPR)); back.width = canvas.width; back.height = canvas.height; internalRequestRender(); } };

        const findNodeAt = (wx, wy) => { const sorted = [...nodesRef.current].sort((a, b) => b.scale - a.scale); for (const n of sorted) { const dx = wx - n.x; const dy = wy - n.y; if (dx * dx + dy * dy < (n.w * n.scale / 2) * (n.w * n.scale / 2)) return n; } return null; };

        // Track dragged node state for collision detection
        let dragLastWorld = null;
        let dragLastTime = 0;
        
        // Helper: Apply collisions along drag path - dragged node pushes others, isn't pushed back
        const applyCollisionsAt = (draggedNode, x, y, vx, vy) => {
            const draggedRadius = (draggedNode.w * draggedNode.scale / 2);
            
            nodesRef.current.forEach((other) => {
                if (other === draggedNode || other.isDragging) return;
                
                const dx = x - other.x;
                const dy = y - other.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                const otherRadius = (other.w * other.scale / 2);
                const minDist = draggedRadius + otherRadius;
                
                if (distance < minDist && distance > 0) {
                    const overlap = minDist - distance;
                    const nx = dx / distance;
                    const ny = dy / distance;
                    
                    // Calculate drag speed for force magnitude
                    const dragSpeed = Math.sqrt(vx * vx + vy * vy);
                    
                    // MASSIVE collision forces - LAUNCH nodes based on drag speed! 🚀
                    const baseImpulse = overlap * 8.0; // Much stronger base push
                    const velocityImpulse = dragSpeed * 12.0; // HUGE speed multiplier - fast drags = LAUNCH!
                    const totalImpulse = baseImpulse + velocityImpulse;
                    
                    // ONLY apply force to OTHER node (dragged node stays locked to cursor)
                    other.vx = other.vx || 0;
                    other.vy = other.vy || 0;
                    other.vx -= nx * totalImpulse;
                    other.vy -= ny * totalImpulse;
                    
                    // Push other node away completely
                    const separation = overlap * 1.2;
                    other.x -= nx * separation;
                    other.y -= ny * separation;
                }
            });
        };

        const onPointerDown = (e) => {
            if (e.target !== canvas || document.querySelector('.panel-wrap') || document.querySelector('.image-gallery-searchbar')?.contains(e.target)) return;
            e.preventDefault();
            const r = canvas.getBoundingClientRect();
            mx = e.clientX - r.left;
            my = e.clientY - r.top;
            dragPointerId = e.pointerId;
            dragAccum = 0;
            const wp = worldFromScreen(mx, my);
            const hitNode = findNodeAt(wp.x, wp.y);
            if (hitNode) {
                draggedNodeRef.current = hitNode;
                dragLastWorld = { x: wp.x, y: wp.y };
                dragLastTime = performance.now();
                hitNode.isDragging = true;
                hitNode.vx = 0;
                hitNode.vy = 0;
                runPhysics.current = true;
            }
            canvas.setPointerCapture?.(e.pointerId);
            internalRequestRender();
        };

        const onPointerMove = (e) => {
            if (dragPointerId && e.pointerId !== dragPointerId) return;
            const r = canvas.getBoundingClientRect();
            const pMx = mx, pMy = my;
            mx = e.clientX - r.left;
            my = e.clientY - r.top;
            if (dragPointerId) {
                dragAccum += Math.hypot(mx - pMx, my - pMy);
                if (draggedNodeRef.current) {
                    const draggedNode = draggedNodeRef.current;
                    const wp = worldFromScreen(mx, my);
                    const now = performance.now();
                    const dt = Math.max(1, now - dragLastTime);
                    
                    // Store old position for path sweep
                    const oldX = draggedNode.x;
                    const oldY = draggedNode.y;
                    
                    // IMMEDIATELY update dragged node to cursor (stays locked)
                    draggedNode.x = wp.x;
                    draggedNode.y = wp.y;
                    
                    // Calculate velocity
                    const vx = (wp.x - dragLastWorld.x) / dt * 16;
                    const vy = (wp.y - dragLastWorld.y) / dt * 16;
                    draggedNode.vx = vx;
                    draggedNode.vy = vy;
                    
                    // NOW sweep collision path from old → new position
                    const dx = draggedNode.x - oldX;
                    const dy = draggedNode.y - oldY;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    
                    if (distance > 0) {
                        const stepSize = 15;
                        const steps = Math.max(1, Math.ceil(distance / stepSize));
                        
                        // Check collisions along the drag path
                        for (let i = 1; i <= steps; i++) {
                            const t = i / steps;
                            const checkX = oldX + dx * t;
                            const checkY = oldY + dy * t;
                            
                            // Apply collisions to other nodes at this position
                            applyCollisionsAt(draggedNode, checkX, checkY, vx, vy);
                        }
                    }
                    
                    dragLastWorld = wp;
                    dragLastTime = now;
                    runPhysics.current = true;
                } else {
                    const dx = (mx - pMx) / cameraState.current.zoom;
                    const dy = (my - pMy) / cameraState.current.zoom;
                    cameraState.current.camX -= dx;
                    cameraState.current.camY -= dy;
                }
            } else {
                const wp = worldFromScreen(mx, my);
                const hitNode = findNodeAt(wp.x, wp.y);
                if (hoveredNodeRef.current !== hitNode) {
                    if (hitNode) {
                        effectsRef.current.push({ node: hitNode, startTime: performance.now() });
                        runPhysics.current = true;
                    }
                    hoveredNodeRef.current = hitNode;
                }
            }
            internalRequestRender();
        };

        const onPointerUp = (e) => {
            if (!dragPointerId || e.pointerId !== dragPointerId) return;
            if (draggedNodeRef.current) {
                draggedNodeRef.current.isDragging = false;
                // Keep velocity for momentum - it will decay naturally in physics
                draggedNodeRef.current = null;
                dragLastWorld = null;
                runPhysics.current = true;
            }
            dragPointerId = null;
            canvas.releasePointerCapture?.(e.pointerId);
            clickSuppressUntil = performance.now() + 250;
            if (dragAccum < 8) {
                onClick();
            }
            internalRequestRender();
        };

        const onPointerLeave = () => { hoveredNodeRef.current = null; internalRequestRender(); };
        const onWheel = (e) => { if (document.querySelector('.panel-wrap') || document.querySelector('.image-gallery-searchbar')?.contains(e.target)) return; const isZoom = e.ctrlKey || e.metaKey; if (isZoom) { e.preventDefault(); const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; const factor = Math.exp(-e.deltaY * 0.0068); const zPrime = clamp(cameraState.current.zoom * factor, 0.05, 5); zoomAnchorScreen = { x: mx, y: my }; zoomAnchorWorld = worldFromScreen(mx, my); cameraState.current.zTarget = zPrime; setInteracting(300); internalRequestRender(); } else { e.preventDefault(); const k = 1 / cameraState.current.zoom; cameraState.current.camX += e.deltaX * k; cameraState.current.camY += e.deltaY * k; cameraState.current.vX = e.deltaX * 0.02 * k; cameraState.current.vY = e.deltaY * 0.02 * k; setInteracting(120); internalRequestRender(); } };
        let gestureLast = 1; const onGestureStart = (e) => { gestureLast = 1; const r = canvas.getBoundingClientRect(); mx = e.clientX - r.left; my = e.clientY - r.top; zoomAnchorScreen = { x: mx, y: my }; zoomAnchorWorld = worldFromScreen(mx, my); zoomActiveUntil = performance.now() + 400; }; const onGestureChange = (e) => { const PINCH_SENSITIVITY = 64; const scaleRatio = e.scale / gestureLast; const amplifiedRatio = 2 + (scaleRatio - 1) * PINCH_SENSITIVITY; gestureLast = e.scale; cameraState.current.zTarget = clamp(cameraState.current.zoom * amplifiedRatio, 0.05, 5); setInteracting(); internalRequestRender(); }; const onGestureEnd = () => { zoomActiveUntil = performance.now() + 200; };
        const onClick = async () => { if (performance.now() < clickSuppressUntil) return; const wp = worldFromScreen(mx, my); const hitNode = findNodeAt(wp.x, wp.y); if (!hitNode) return; const file = hitNode.file; if (stateRef.isSelectionMode) { onToggleSelection(file.path); return; } if (stateRef.isSearching && !stateRef.matchingImagePaths.has(file.path)) return; const cached = imageCache.get(file.path); if (!cached?.bitmap) return; const tempCanvas = document.createElement('canvas'); tempCanvas.width = 16; tempCanvas.height = 20; tempCanvas.getContext('2d').drawImage(cached.bitmap, 0, 0, 16, 20); const lowResUrl = tempCanvas.toDataURL('image/jpeg', 0.1); const initialBitmap = cached.hiresBitmap || cached.bitmap; onCardClick({ path: file.path, lowResUrl, initialBitmap }); };

        sizeToContainer();
        internalRequestRender();
        let resizeRAF = 0;
        const ro = new ResizeObserver(() => { cancelAnimationFrame(resizeRAF); resizeRAF = requestAnimationFrame(sizeToContainer); });
        ro.observe(root);

        canvas.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointerleave', onPointerLeave);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('gesturestart', onGestureStart);
        canvas.addEventListener('gesturechange', onGestureChange);
        canvas.addEventListener('gestureend', onGestureEnd);

        return () => {
            ro.disconnect();
            onCacheUpdate.current = () => { };
            cancelAnimationFrame(rafId);
            running = false;
            canvas.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('gesturestart', onGestureStart);
            canvas.removeEventListener('gesturechange', onGestureChange);
            canvas.removeEventListener('gestureend', onGestureEnd);
        };
    }, [isFullTab, onCardClick, onToggleSelection, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, containerRef, canvasRef, nodesRefProp, isLightMode]);

};

/**
 * A hook to manage dynamic SVG conversion.
 */


const useExcalidrawConverter = (currentFilePath, config, baseDir) => {
    const [status, setStatus] = useState('loading'); // loading, ready, error
    const [error, setError] = useState(null);
    const [logs, setLogs] = useState([]);
    const [conversionProgress, setConversionProgress] = useState({ processed: 0, total: 0, skipped: 0 });
    const [isConverting, setIsConverting] = useState(false);
    const dependenciesRef = useRef(null);

    // --- CORRECTED ---
    // Switched to the UMD (Universal Module Definition) version of Excalidraw.
    // This version is a single script file designed for direct browser use and avoids module resolution issues.
    const EXCALIDRAW_UMD_URL = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js";


    const log = useCallback((message) => {
        setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev.slice(0, 100)]);
    }, []);

    useEffect(() => {
        const loadDependencies = async () => {
            try {
                log('Loading dependencies...');
                window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;

                // Ensure React and ReactDOM are on window before loading Excalidraw
                if (!window.React) {
                    try {
                        window.React = typeof require !== 'undefined' ? require('react') : null;
                    } catch (e) {
                        console.warn("[Assets Library] Failed to require('react'):", e);
                    }
                    if (!window.React) {
                        log('Fetching React UMD...');
                        await Core.Converter.loadLegacyScript(REACT_CDN_URL, "React", baseDir);
                    }
                }

                if (!window.ReactDOM) {
                    try {
                        window.ReactDOM = typeof require !== 'undefined' ? (require('react-dom/client') || require('react-dom')) : null;
                    } catch (e) {
                        console.warn("[Assets Library] Failed to require('react-dom'):", e);
                    }
                    if (!window.ReactDOM) {
                        log('Fetching ReactDOM UMD...');
                        await Core.Converter.loadLegacyScript(REACT_DOM_CDN_URL, "ReactDOM", baseDir);
                    }
                }

                // --- CORRECTED ---
                // We now load all dependencies using the same robust legacy script loader.
                // The browser's own HTTP cache will handle storing and retrieving the script after the first load.
                const excalidrawPromise = Core.Converter.loadLegacyScript(EXCALIDRAW_UMD_URL, "ExcalidrawLib", baseDir);
                const lzStringPromise = Core.Converter.loadLegacyScript(LZ_STRING_CDN_URL, "LZString", baseDir);

                // Wait for scripts to be loaded (fonts will be loaded on-demand when needed)
                await Promise.all([excalidrawPromise, lzStringPromise]);

                // The UMD script attaches the Excalidraw library to window.ExcalidrawLib
                dependenciesRef.current = {
                    ExcalidrawModule: window.ExcalidrawLib,
                    LZString: window.LZString,
                    fontData: null // Will be loaded on-demand when conversion starts
                };

                log('Dependencies loaded successfully.');
                setStatus('ready');
            } catch (err) {
                console.error("Failed to load Excalidraw dependencies:", err);
                log(`ERROR: ${err.message}`);
                setError(err.message);
                setStatus('error');
            }
        };
        loadDependencies();
    }, [log]);

    const runConversionCheck = useCallback(async (onComplete) => {
        if (status !== 'ready' || !dependenciesRef.current) {
            log('Converter not ready.');
            onComplete?.(false);
            return;
        }
        
        // Load fonts on-demand (only when conversion is actually needed)
        if (!dependenciesRef.current.fontData) {
            log('Loading fonts for conversion...');
            try {
                const fontData = await Core.loadFontData(log, currentFilePath);
                dependenciesRef.current.fontData = fontData;
                log('Fonts loaded successfully.');
            } catch (error) {
                log(`Failed to load fonts: ${error.message}`);
                setIsConverting(false);
                onComplete?.(false);
                return;
            }
        }
        
        log('Starting conversion check...');
        setIsConverting(true);
        setConversionProgress({ processed: 0, total: 0, skipped: 0 });

        try {
            // Yield to UI thread before heavy file scanning
            await new Promise(resolve => setTimeout(resolve, 0));
            
            const allFiles = dc.app.vault.getFiles();
            const paths = (config?.localPath || (baseDir ? `${baseDir}/assets` : FOLDER_PATH)).split(/[,,;]/).map(p => p.trim()).filter(Boolean);
            const filesInFolder = allFiles.filter(f => paths.some(p => f.path.startsWith(p)));
            const mdFiles = filesInFolder.filter(f => f.extension === 'md');
            const svgFilesMap = new Map(filesInFolder.filter(f => f.extension === 'svg').map(f => [f.path.replace(/\.svg$/i, ''), f]));

            const filesToConvert = [];
            const MTIME_GRACE_PERIOD_MS = 2000; // 2-second grace period

            for (const mdFile of mdFiles) {
                const basePath = mdFile.path.replace(/\.md$/i, '');
                const correspondingSvg = svgFilesMap.get(basePath);

                if (!correspondingSvg) {
                    // Condition 1: SVG does not exist. Always convert.
                    filesToConvert.push(mdFile);
                    continue;
                }

                // Condition 2 (BUG FIX): MD file is newer than the SVG file, accounting for a grace period.
                // This prevents re-conversion if timestamps are too close together due to fast file writes or filesystem resolution limits.
                if (mdFile.stat.mtime > correspondingSvg.stat.mtime + MTIME_GRACE_PERIOD_MS) {
                    filesToConvert.push(mdFile);
                }
            }

            if (filesToConvert.length === 0) {
                log('All assets are up-to-date.');
                setIsConverting(false);
                onComplete?.(false);
                return;
            }

            log(`Found ${filesToConvert.length} files to convert/update.`);
            setConversionProgress({ processed: 0, total: filesToConvert.length, skipped: 0 });

            // Detect file dependencies (files that reference other files)
            const detectDependencies = async (file) => {
                try {
                    const content = await dc.app.vault.adapter.read(file.path);
                    const dependencies = [];
                    
                    // Look for file references in the content
                    // Matches: [[filename]], ![[filename]], [[folder/filename]]
                    const linkPattern = /\[\[([^\]]+)\]\]/g;
                    let match;
                    while ((match = linkPattern.exec(content)) !== null) {
                        const refPath = match[1];
                        // Check if this references another .md file in our folder
                        const possiblePaths = [];
                        for (const p of paths) {
                            possiblePaths.push(
                                `${p}/${refPath}.md`,
                                `${p}/${refPath}`,
                                refPath.endsWith('.md') ? `${p}/${refPath}` : null
                            );
                        }
                        const filteredPaths = possiblePaths.filter(Boolean);
                        
                        for (const possPath of filteredPaths) {
                            if (mdFiles.find(f => f.path === possPath)) {
                                dependencies.push(possPath);
                                break;
                            }
                        }
                    }
                    
                    return dependencies;
                } catch (err) {
                    return [];
                }
            };

            // Build dependency map
            log('Analyzing file dependencies...');
            await new Promise(resolve => setTimeout(resolve, 0));
            
            const dependencyMap = new Map();
            for (const file of filesToConvert) {
                const deps = await detectDependencies(file);
                if (deps.length > 0) {
                    dependencyMap.set(file.path, deps);
                    log(`📎 ${file.basename} depends on ${deps.length} file(s)`);
                }
            }

            // Sort files: independent files first, dependent files last
            const sortedFiles = [];
            const filesWithDeps = [];
            
            for (const file of filesToConvert) {
                if (dependencyMap.has(file.path)) {
                    filesWithDeps.push(file);
                } else {
                    sortedFiles.push(file);
                }
            }
            
            // Add dependent files at the end
            sortedFiles.push(...filesWithDeps);
            
            if (filesWithDeps.length > 0) {
                log(`⏳ ${filesWithDeps.length} file(s) will be converted last (have dependencies)`);
            }

            const queue = [...sortedFiles];
            let processed = 0;
            let skipped = 0;

            const worker = async () => {
                while (queue.length > 0) {
                    const file = queue.shift();
                    if (!file) continue;
                    
                    // Yield every 2 files to prevent lag spikes
                    if (processed % 2 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                    
                    const result = await Core.Converter.processFileWithLibrary(
                        file.path, 
                        dependenciesRef.current.ExcalidrawModule, 
                        dependenciesRef.current.LZString, 
                        dependenciesRef.current.fontData, 
                        log
                    );
                    
                    if (result.skipped) {
                        skipped++;
                    }
                    processed++;
                    
                    // Throttle progress updates to every 2 files
                    if (processed % 2 === 0 || processed === filesToConvert.length) {
                        setConversionProgress({ 
                            processed, 
                            total: filesToConvert.length, 
                            skipped 
                        });
                    }
                }
            };

            // Use single worker to prevent overwhelming the system
            await worker();

            log('Conversion check complete.');
            setIsConverting(false);
            onComplete?.(true);
        } catch (err) {
            console.error('Error during conversion check:', err);
            log(`ERROR: ${err.message}`);
            setIsConverting(false);
            onComplete?.(false);
        }
    }, [status, log]);

    return { status, error, logs, runConversionCheck, converterDeps: dependenciesRef.current, conversionProgress, isConverting };
};

/**
 * A hook to manage GitHub asset synchronization
 */
const useGitHubSync = (converterStatus, converterDeps, hasConsented, CONSENT_FILE_PATH, currentFilePath, config) => {
    const [syncStatus, setSyncStatus] = useState('idle'); // idle, syncing, success, error
    const [syncProgress, setSyncProgress] = useState({ processed: 0, converted: 0, total: 0, skipped: 0 });
    const [syncLogs, setSyncLogs] = useState([]);
    const [syncError, setSyncError] = useState(null);
    const hasInitialSyncRef = useRef(false);
    const isCancelledRef = useRef(false);
    const configRef = useRef(config);
    useEffect(() => {
        configRef.current = config;
    }, [config]);

    const log = useCallback((message) => {
        setSyncLogs(prev => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev.slice(0, 100)]);
    }, []);

    const cancelSync = useCallback(() => {
        isCancelledRef.current = true;
        setSyncStatus('idle');
        log('Sync stopped by user.');
    }, [log]);

    const syncFromGitHub = useCallback(async (forceDownload = false, overrideConfig = null) => {
        if (syncStatus === 'syncing') {
            log('Sync already in progress...');
            return;
        }

        if (!converterDeps) {
            log('Converter not ready yet...');
            return;
        }

        // Load fonts on-demand (only when sync/conversion is actually needed)
        if (!converterDeps.fontData) {
            log('Loading fonts for conversion...');
            try {
                const fontData = await Core.loadFontData(log, currentFilePath);
                converterDeps.fontData = fontData;
                log('Fonts loaded successfully.');
            } catch (error) {
                log(`Failed to load fonts: ${error.message}`);
                setSyncStatus('error');
                setSyncError(error.message);
                return;
            }
        }

        isCancelledRef.current = false;
        setSyncStatus('syncing');
        setSyncError(null);
        setSyncProgress({ processed: 0, converted: 0, total: 0, skipped: 0 });
        log('Starting GitHub sync in background...');

        const activeConfig = overrideConfig || configRef.current;
        try {
            const repos = activeConfig.repos && activeConfig.repos.length > 0 ? activeConfig.repos : [
                {
                    repoOwner: activeConfig.repoOwner || GITHUB_REPO_OWNER,
                    repoName: activeConfig.repoName || GITHUB_REPO_NAME,
                    branch: activeConfig.branch || GITHUB_BRANCH,
                    assetsPath: activeConfig.assetsPath || GITHUB_ASSETS_PATH
                }
            ];

            let aggregatedResult = { downloaded: 0, skipped: 0, converted: 0, failed: 0 };
            const reposWithFiles = [];
            let totalFilesCount = 0;

            log(`Checking ${repos.length} GitHub repositories...`);

            for (const repo of repos) {
                if (isCancelledRef.current) break;
                try {
                    const files = await Core.GitHub.fetchAssetsList(log, repo);
                    reposWithFiles.push({ repo, files });
                    totalFilesCount += files.length;
                } catch (e) {
                    log(`Failed to fetch file list for ${repo.repoOwner}/${repo.repoName}: ${e.message}`);
                }
            }

            if (isCancelledRef.current) {
                setSyncStatus('idle');
                return;
            }

            if (totalFilesCount === 0) {
                log('No files found to synchronize across all repositories.');
                setSyncStatus('success');
                return;
            }

            setSyncProgress({ processed: 0, converted: 0, total: totalFilesCount, skipped: 0 });

            let overallProcessed = 0;
            let overallConverted = 0;
            let overallSkipped = 0;

            for (const item of reposWithFiles) {
                if (isCancelledRef.current) break;

                let lastRepoProcessed = 0;
                let lastRepoConverted = 0;
                let lastRepoSkipped = 0;

                log(`Syncing repository: ${item.repo.repoOwner}/${item.repo.repoName}...`);
                const result = await Core.GitHub.downloadAllAssets(
                    log, 
                    (processed, converted, total, skipped) => {
                        const deltaProcessed = processed - lastRepoProcessed;
                        const deltaConverted = converted - lastRepoConverted;
                        const deltaSkipped = skipped - lastRepoSkipped;

                        overallProcessed += deltaProcessed;
                        overallConverted += deltaConverted;
                        overallSkipped += deltaSkipped;

                        lastRepoProcessed = processed;
                        lastRepoConverted = converted;
                        lastRepoSkipped = skipped;

                        setSyncProgress({
                            processed: overallProcessed,
                            converted: overallConverted,
                            total: totalFilesCount,
                            skipped: overallSkipped
                        });
                    },
                    converterDeps,
                    {
                        ...item.repo,
                        localPath: `${activeConfig.localPath || FOLDER_PATH}/${item.repo.repoName}`
                    },
                    forceDownload,
                    isCancelledRef,
                    item.files
                );

                aggregatedResult.downloaded += result.downloaded;
                aggregatedResult.skipped += result.skipped;
                aggregatedResult.converted += result.converted;
                aggregatedResult.failed += result.failed;
            }

            if (isCancelledRef.current) {
                setSyncStatus('idle');
                return;
            }

            const message = `✅ Sync complete: ${aggregatedResult.downloaded} new, ${aggregatedResult.skipped} existing, ${aggregatedResult.converted} converted`;
            log(message);

            setSyncStatus('success');
        } catch (error) {
            console.error('GitHub sync error:', error);
            log(`ERROR: ${error.message}`);
            setSyncError(error.message);
            setSyncStatus('error');
        }
    }, [syncStatus, log, converterDeps, config]);

    // Auto-sync disabled. Sync is now strictly manual.

    return {
        syncStatus,
        syncProgress,
        syncLogs,
        syncError,
        syncFromGitHub,
        cancelSync
    };
};

// --- 3. View Components ---

/**
 * Renders the Grid View canvas.
 */
const GridView = ({ isFullTab, imagesToDisplay, onCardClick, isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, resetViewKey, isTransitioning, initialPositions, onTransitionEnd, isLightMode }) => {
    const containerRef = useRef(null);
    const canvasRef = useRef(null);

    useInteractiveCanvas(
        { containerRef, canvasRef, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, resetViewKey, isTransitioning, initialPositions, onTransitionEnd },
        isFullTab, onCardClick, imagesToDisplay, isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection, isLightMode
    );

    return (
        <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
            <canvas ref={canvasRef} className="interactive-canvas" />
        </div>
    );
};

/**
 * Renders the Graph View canvas.
 */
const GraphView = ({ isFullTab, imagesToDisplay, onCardClick, a888aTagsMap, isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, resetViewKey, nodesRef, isLightMode }) => {
    const containerRef = useRef(null);
    const canvasRef = useRef(null);

    useGraphCanvas(
        { containerRef, canvasRef, imageCache, requestImages, requestedSet, onCacheUpdate, interactingUntilRef, resetViewKey, nodesRef },
        isFullTab, onCardClick, imagesToDisplay, a888aTagsMap, isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection, isLightMode
    );

    return (
        <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
            <canvas ref={canvasRef} className="interactive-canvas" />
        </div>
    );
};

const ConverterLoadingView = ({ logs, syncStatus, syncProgress, syncLogs }) => {
    const allLogs = useMemo(() => {
        // Combine converter logs and sync logs, most recent first
        const combined = [...syncLogs, ...logs];
        return combined.slice(0, 100); // Limit to 100 most recent
    }, [logs, syncLogs]);

    const progressText = useMemo(() => {
        if (syncStatus === 'syncing') {
            const { processed, converted, total, skipped } = syncProgress;
            if (total > 0) {
                return `Processing: ${processed}/${total} files • ${converted} converted • ${skipped} skipped`;
            }
            return 'Fetching file list from GitHub...';
        }
        return 'Loading Excalidraw libraries and preparing for SVG conversion...';
    }, [syncStatus, syncProgress]);

    return (
        <div style={{ padding: '20px', textAlign: 'center', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: 'var(--background-primary)' }}>
            <h3 style={{ color: '#d1bfff' }}>
                {syncStatus === 'syncing' ? '🔄 Syncing Assets...' : '⚙️ Initializing Asset Engine...'}
            </h3>
            <p style={{ color: '#8a7c9c', fontSize: '13px', maxWidth: '500px', lineHeight: '1.6' }}>
                {progressText}
            </p>
            {syncStatus === 'syncing' && syncProgress.total > 0 && (
                <div style={{ width: '80%', maxWidth: '500px', marginTop: '15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#888', marginBottom: '6px' }}>
                        <span>Downloaded: {syncProgress.processed - syncProgress.skipped}</span>
                        <span>Converted: {syncProgress.converted}</span>
                        <span>Skipped: {syncProgress.skipped}</span>
                    </div>
                    <div style={{ width: '100%', height: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ 
                            width: `${(syncProgress.processed / syncProgress.total) * 100}%`, 
                            height: '100%', 
                            background: 'linear-gradient(90deg, #8758FF, #C77DF2)',
                            transition: 'width 0.3s ease'
                        }}></div>
                    </div>
                </div>
            )}
            <div style={{ height: '200px', width: 'clamp(300px, 80%, 600px)', background: 'rgba(0,0,0,0.3)', border: '1px solid #444', borderRadius: '6px', padding: '10px', overflowY: 'auto', fontSize: '11px', textAlign: 'left', fontFamily: 'monospace', color: '#aaa', marginTop: '20px' }}>
                {allLogs.map((log, i) => <div key={i}>{log}</div>)}
            </div>
        </div>
    );
};

const ConverterErrorView = ({ error }) => (
    <div style={{ padding: '20px', textAlign: 'center', color: '#ff8a8a', background: 'var(--background-primary)', height: '100%', display: 'grid', placeContent: 'center' }}>
        <h3>Critical Initialization Error</h3>
        <p>Could not load required libraries for Excalidraw conversion.</p>
        <p style={{ color: '#aaa', fontSize: '12px', marginTop: '10px', fontFamily: 'monospace' }}>{error}</p>
    </div>
);

const BackgroundSyncNotification = ({ syncStatus, syncProgress, onDismiss, onCancel, notificationIndex }) => {
    if (syncStatus !== 'syncing') return null;

    const { processed, converted, total, skipped } = syncProgress;
    const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

    return (
        <div style={{
            position: 'absolute',
            top: `${60 + (notificationIndex * 130)}px`,
            right: '20px',
            zIndex: 10000,
            background: 'var(--background-secondary)',
            border: '1px solid var(--interactive-accent)',
            borderRadius: '8px',
            padding: '12px 16px',
            minWidth: '340px',
            maxWidth: '400px',
            backdropFilter: 'blur(16px)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25), 0 0 30px var(--background-modifier-border)',
            animation: 'slideInRight 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            transition: 'top 0.3s ease'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--interactive-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                    </svg>
                    <span style={{ color: 'var(--text-normal)', fontSize: '13px', fontWeight: '600' }}>
                        GitHub Sync
                    </span>
                </div>
                {onDismiss && (
                    <button 
                        onClick={onDismiss}
                        style={{
                            all: 'unset',
                            cursor: 'pointer',
                            color: 'var(--text-muted)',
                            fontSize: '20px',
                            lineHeight: '1',
                            padding: '0 4px',
                            transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => e.target.style.color = 'var(--text-normal)'}
                        onMouseLeave={(e) => e.target.style.color = 'var(--text-muted)'}
                        title="Dismiss (continues in background)"
                    >×</button>
                )}
            </div>
            
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                {total > 0 ? `${processed}/${total} files (${percentage}%)` : 'Fetching file list...'}
            </div>

            {total > 0 && (
                <>
                    <div style={{ 
                        height: '4px', 
                        background: 'var(--background-primary)', 
                        borderRadius: '2px', 
                        overflow: 'hidden',
                        marginBottom: '8px'
                    }}>
                        <div style={{ 
                            width: `${percentage}%`, 
                            height: '100%', 
                            background: 'var(--interactive-accent)',
                            transition: 'width 0.3s ease',
                            borderRadius: '2px'
                        }}></div>
                    </div>
                    
                    <div style={{ 
                        display: 'flex', 
                        gap: '10px', 
                        fontSize: '10px', 
                        color: '#777',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap'
                    }}>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ color: 'var(--interactive-accent)' }}>✓</span> {converted} converted
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ color: '#4CAF50' }}>↓</span> {processed - skipped} new
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ color: '#666' }}>⊘</span> {skipped} skipped
                            </span>
                        </div>
                        {onCancel && (
                            <button 
                                onClick={onCancel}
                                style={{
                                    all: 'unset',
                                    cursor: 'pointer',
                                    color: '#ff6b6b',
                                    fontWeight: 'bold',
                                    fontSize: '10px',
                                    background: 'rgba(255, 107, 107, 0.1)',
                                    padding: '2px 8px',
                                    borderRadius: '4px',
                                    transition: 'background 0.2s'
                                }}
                                onMouseEnter={(e) => e.target.style.background = 'rgba(255, 107, 107, 0.2)'}
                                onMouseLeave={(e) => e.target.style.background = 'rgba(255, 107, 107, 0.1)'}
                            >
                                Stop Sync
                            </button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

const BackgroundConversionNotification = ({ isConverting, conversionProgress, onDismiss, notificationIndex }) => {
    if (!isConverting) return null;

    const { processed, total, skipped } = conversionProgress;
    const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
    const converted = processed - skipped;

    return (
        <div style={{
            position: 'absolute',
            top: `${60 + (notificationIndex * 130)}px`,
            right: '20px',
            zIndex: 10000,
            background: 'var(--background-secondary)',
            border: '1px solid var(--interactive-accent)',
            borderRadius: '8px',
            padding: '12px 16px',
            minWidth: '340px',
            maxWidth: '400px',
            backdropFilter: 'blur(16px)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25), 0 0 30px var(--background-modifier-border)',
            animation: 'slideInRight 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            transition: 'top 0.3s ease'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--interactive-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 6v6l4 2"/>
                    </svg>
                    <span style={{ color: 'var(--text-normal)', fontSize: '13px', fontWeight: '600' }}>
                        SVG Conversion
                    </span>
                </div>
                {onDismiss && (
                    <button 
                        onClick={onDismiss}
                        style={{
                            all: 'unset',
                            cursor: 'pointer',
                            color: 'var(--text-muted)',
                            fontSize: '20px',
                            lineHeight: '1',
                            padding: '0 4px',
                            transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => e.target.style.color = 'var(--text-normal)'}
                        onMouseLeave={(e) => e.target.style.color = 'var(--text-muted)'}
                        title="Dismiss (continues in background)"
                    >×</button>
                )}
            </div>
            
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                {total > 0 ? `${processed}/${total} files (${percentage}%)` : 'Scanning files...'}
            </div>

            {total > 0 && (
                <>
                    <div style={{ 
                        height: '4px', 
                        background: 'var(--background-primary)', 
                        borderRadius: '2px', 
                        overflow: 'hidden',
                        marginBottom: '8px'
                    }}>
                        <div style={{ 
                            width: `${percentage}%`, 
                            height: '100%', 
                            background: 'var(--interactive-accent)',
                            transition: 'width 0.3s ease',
                            borderRadius: '2px'
                        }}></div>
                    </div>
                    
                    <div style={{ 
                        display: 'flex', 
                        gap: '10px', 
                        fontSize: '10px', 
                        color: '#777',
                        justifyContent: 'flex-start',
                        flexWrap: 'wrap'
                    }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ color: '#FFA726' }}>✓</span> {converted} converted
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ color: '#666' }}>⊘</span> {skipped} skipped
                        </span>
                    </div>
                </>
            )}
        </div>
    );
};


// --- 4. UI Components ---

const DropdownBase = ({ buttonContent, children }) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef(null);
    useEffect(() => {
        const handleClickOutside = (event) => { if (dropdownRef.current && !dropdownRef.current.contains(event.target)) { setIsOpen(false); } };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);
    return (
        <div className="dropdown-container" ref={dropdownRef}>
            <button className="dropdown-btn" onClick={() => setIsOpen(!isOpen)}>
                {buttonContent(isOpen)}
            </button>
            {isOpen && <div className="dropdown-menu">{children(setIsOpen)}</div>}
        </div>
    );
};

const SortDropdown = ({ options, value, onChange }) => {
    const selectedOption = options.find(opt => opt.value === value);
    return (
        <DropdownBase buttonContent={(isOpen) => (
            <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
                <span>{selectedOption?.label || 'Sort By'}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9"></polyline></svg>
            </>
        )}>
            {(setIsOpen) => options.map(option => (
                <div key={option.value} className={`dropdown-item ${value === option.value ? 'active' : ''}`} onClick={() => { onChange(option.value); setIsOpen(false); }}>
                    {option.label}
                </div>
            ))}
        </DropdownBase>
    );
};

const ViewDropdown = ({ value, onChange }) => {
    const options = [
        { value: 'grid', label: 'Grid', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg> },
        { value: 'graph', label: 'Graph', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg> }
    ];
    const selectedOption = options.find(opt => opt.value === value);
    return (
        <DropdownBase buttonContent={(isOpen) => (
            <>
                {selectedOption.icon}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9"></polyline></svg>
            </>
        )}>
            {(setIsOpen) => options.map(option => (
                <div key={option.value} className={`dropdown-item with-icon ${value === option.value ? 'active' : ''}`} onClick={() => { onChange(option.value); setIsOpen(false); }}>
                    {option.icon} <span>{option.label}</span>
                </div>
            ))}
        </DropdownBase>
    );
};

const TagsPanel = ({ tags, onTagClick, onClose }) => {
    if (!tags || tags.length === 0) {
        return <div className="tags-panel">No tags found.</div>;
    }
    return (
        <div className="tags-panel">
            {tags.map(tag => (
                <button key={tag} className="tag-btn" onClick={() => onTagClick(tag)}>
                    {tag}
                </button>
            ))}
        </div>
    );
};

const SearchBar = ({ searchTerm, onSearchChange, onClear, onInputMount, sortOption, onSortChange, sortOptions, viewType, onViewChange, isSelectionMode, onToggleSelectionMode, allTags, onTagClick, onResetView, onSyncGitHub, syncStatus, onOpenSettings }) => {
    const [position, setPosition] = useState({ x: 20, y: 20 });
    const [isFocused, setIsFocused] = useState(false);
    const [isTagsPanelOpen, setIsTagsPanelOpen] = useState(false);
    const dragRef = useRef({ isDragging: false, startX: 0, startY: 0, initialX: 0, initialY: 0, moveHandler: null, upHandler: null });
    const barRef = useRef(null);
    const localInputRef = useRef(null);
    const STORAGE_KEY = 'image-gallery-searchbar-pos';
    useEffect(() => { if (localInputRef.current && onInputMount) { onInputMount(localInputRef.current); } }, [onInputMount]);

    useEffect(() => {
        try {
            const savedPos = localStorage.getItem(STORAGE_KEY);
            if (savedPos) { setPosition(JSON.parse(savedPos)); }
        } catch (e) {
            console.error("Could not load search bar position:", e);
        }
    }, []);

    useEffect(() => { const ref = dragRef.current; return () => { window.removeEventListener('pointermove', ref.moveHandler); window.removeEventListener('pointerup', ref.upHandler); }; }, []);
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (barRef.current && !barRef.current.contains(event.target)) {
                setIsFocused(false);
                setIsTagsPanelOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside); return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const onPointerDown = (e) => {
        if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.dropdown-container')) return;
        e.stopPropagation();
        const moveHandler = (moveEvent) => {
            if (!dragRef.current.isDragging) return;
            const dx = moveEvent.clientX - dragRef.current.startX;
            const dy = moveEvent.clientY - dragRef.current.startY;
            setPosition({ x: dragRef.current.initialX + dx, y: dragRef.current.initialY + dy });
        };
        const upHandler = () => {
            dragRef.current.isDragging = false;
            setPosition(currentPos => {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPos));
                } catch (e) {
                    console.error("Could not save search bar position:", e);
                }
                return currentPos;
            });
            window.removeEventListener('pointermove', moveHandler);
            window.removeEventListener('pointerup', upHandler);
        };
        dragRef.current = { isDragging: true, startX: e.clientX, startY: e.clientY, initialX: position.x, initialY: position.y };
        window.addEventListener('pointermove', moveHandler);
        window.addEventListener('pointerup', upHandler);
    };
    const isCollapsed = !isFocused && !searchTerm && !isSelectionMode;
    const handleBarClick = (e) => {
        if (isCollapsed) {
            setIsFocused(true);
            localInputRef.current?.focus();
        } else if (e.target.closest('.action-menu-icon')) {
            setIsFocused(false);
            setIsTagsPanelOpen(false);
        }
    };
    const handleTagButtonClick = (tag) => {
        onTagClick(tag);
        setIsTagsPanelOpen(false);
        setIsFocused(true);
    };
    return (
        <div ref={barRef} className={`image-gallery-searchbar ${isCollapsed ? 'collapsed' : ''}`} style={{ transform: `translate(${position.x}px, ${position.y}px)` }} onClick={handleBarClick}>
            <svg className="action-menu-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" onPointerDown={onPointerDown} title="Drag to move controls">
                <line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>
            </svg>
            <div className="search-bar-divider"></div>
            <ViewDropdown value={viewType} onChange={onViewChange} />
            <div className="search-bar-divider"></div>
            <input ref={localInputRef} type="text" placeholder="Search..." value={searchTerm} onChange={(e) => onSearchChange(e.target.value)} onFocus={() => setIsFocused(true)} />
            {searchTerm && (<button className="clear-btn" onClick={onClear}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>)}
            <div className="search-bar-divider"></div>
            <SortDropdown options={sortOptions} value={sortOption} onChange={onSortChange} />
            <div className="search-bar-divider"></div>
            <button className="select-btn" onClick={onResetView} title="Reset View"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 21v-2M21 12h-2M12 3V1M3 12H1m17.66 6.34l-1.42-1.42M4.76 4.76L3.34 3.34m14.32 0l-1.42 1.42M4.76 19.24l-1.42 1.42"></path></svg></button>
            <div className="search-bar-divider"></div>
            <button 
                className={`select-btn ${syncStatus === 'syncing' ? 'active' : ''}`} 
                onClick={onSyncGitHub} 
                disabled={syncStatus === 'syncing'}
                title="Sync from GitHub"
            >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: syncStatus === 'syncing' ? 'spin 1s linear infinite' : 'none' }}>
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                </svg>
            </button>
            <div className="search-bar-divider"></div>
            <button className={`select-btn tag-btn-toggle ${isTagsPanelOpen ? 'active' : ''}`} onClick={() => setIsTagsPanelOpen(!isTagsPanelOpen)} title="Browse Tags"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg></button>
            <div className="search-bar-divider"></div>
            <button className={`select-btn ${isSelectionMode ? 'active' : ''}`} onClick={onToggleSelectionMode} title="Toggle Selection Mode"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg></button>
            <div className="search-bar-divider"></div>
            <button className="select-btn" onClick={onOpenSettings} title="Configure Library & Folders">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
            </button>

            {isTagsPanelOpen && <TagsPanel tags={allTags} onTagClick={handleTagButtonClick} />}
        </div>
    );
};

const MassEditPanel = ({ selectedCount, onApplyPreset, onApplyA888a, onApplyCustom, onQuickAddTag, onDeleteSelected, onHide, onClear, onClose }) => {
    const [key, setKey] = useState('data-tag');
    const [value, setValue] = useState('');
    const [tagInput, setTagInput] = useState('');

    const handleAddTagClick = () => {
        if (tagInput.trim()) {
            onQuickAddTag(tagInput);
            setTagInput('');
        }
    };

    return (
        <div className="mass-edit-panel" style={{ padding: '12px 14px 16px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="mass-edit-header" style={{ padding: '0 0 6px 0', borderBottom: '1px solid var(--background-modifier-border)' }}>
                <h3 style={{ fontSize: '13px', fontWeight: 'bold', margin: 0 }}>Selected: {selectedCount} asset{selectedCount > 1 ? 's' : ''}</h3>
                <button onClick={onClose} className="close-btn" style={{ fontSize: '16px' }}>×</button>
            </div>
            
            <div className="mass-edit-body" style={{ padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {/* 1. Quick Add Tag (Standard Obsidian Tags) */}
                <div className="mass-edit-section">
                    <label style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Quick Add Tag</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <input 
                            type="text" 
                            value={tagInput} 
                            onChange={e => setTagInput(e.target.value)} 
                            placeholder="Add tag (e.g. arrow)" 
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTagClick(); } }}
                            style={{ flexGrow: 1, background: 'var(--background-primary)', border: '1px solid var(--background-modifier-border)', color: 'var(--text-normal)', padding: '5px 8px', borderRadius: '4px', fontSize: '12px' }}
                        />
                        <button className="btn" onClick={handleAddTagClick} disabled={!tagInput.trim()} style={{ padding: '4px 10px', fontSize: '11px' }}>Add Tag</button>
                    </div>
                </div>

                <div className="mass-edit-divider" style={{ margin: '2px 0' }}></div>

                {/* 2. Quick Presets */}
                <div style={{ display: 'flex', gap: '15px' }}>
                    <div className="mass-edit-section" style={{ flex: 1 }}>
                        <label style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>A888a Presets</label>
                        <div className="mass-edit-presets" style={{ gap: '4px' }}>
                            <button className="preset-btn" onClick={() => onApplyA888a('hot+')} style={{ padding: '3px 8px', fontSize: '10px' }}>hot+</button>
                            <button className="preset-btn" onClick={() => onApplyA888a('one')} style={{ padding: '3px 8px', fontSize: '10px' }}>one</button>
                        </div>
                    </div>
                    <div className="mass-edit-section" style={{ flex: 1 }}>
                        <label style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Tags Presets</label>
                        <div className="mass-edit-presets" style={{ gap: '4px' }}>
                            <button className="preset-btn" onClick={() => onApplyPreset('hot+')} style={{ padding: '3px 8px', fontSize: '10px' }}>hot+</button>
                            <button className="preset-btn" onClick={() => onApplyPreset('old')} style={{ padding: '3px 8px', fontSize: '10px' }}>old</button>
                        </div>
                    </div>
                </div>

                <div className="mass-edit-divider" style={{ margin: '2px 0' }}></div>

                {/* 3. Custom Metadata Property */}
                <div className="mass-edit-section">
                    <label style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Custom Property</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <input type="text" value={key} onChange={e => setKey(e.target.value)} placeholder="Prop Name" style={{ width: '40%', background: 'var(--background-primary)', border: '1px solid var(--background-modifier-border)', color: 'var(--text-normal)', padding: '5px 8px', borderRadius: '4px', fontSize: '12px' }} />
                        <input type="text" value={value} onChange={e => setValue(e.target.value)} placeholder="Value" style={{ width: '40%', background: 'var(--background-primary)', border: '1px solid var(--background-modifier-border)', color: 'var(--text-normal)', padding: '5px 8px', borderRadius: '4px', fontSize: '12px' }} />
                        <button className="btn" onClick={() => onApplyCustom(key, value)} disabled={!key.trim()} style={{ padding: '4px 8px', fontSize: '11px', whiteSpace: 'nowrap' }}>Set</button>
                    </div>
                </div>
            </div>

            <div className="mass-edit-footer" style={{ padding: '8px 0 4px 0', borderTop: '1px solid var(--background-modifier-border)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', gap: '6px', width: '100%' }}>
                    <button className="btn ghost" onClick={onHide} style={{ flex: 1, textAlign: 'center', padding: '6px 0', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                            <line x1="1" y1="1" x2="23" y2="23"></line>
                        </svg>
                        Hide Selected
                    </button>
                    <button className="btn ghost" onClick={onClear} style={{ flex: 1, textAlign: 'center', padding: '6px 0', fontSize: '11px' }}>Clear Selection</button>
                </div>
                <button className="btn danger" onClick={onDeleteSelected} style={{ width: '100%', background: '#b71c1c', border: 'none', color: '#fff', padding: '6px 0', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    Delete Assets
                </button>
            </div>
        </div>
    );
};

const ProgressiveImage = ({ lowResSrc, initialBitmap, highResPath, alt }) => {
    const [highResSvgUrl, setHighResSvgUrl] = useState(null);
    const canvasRef = useRef(null);
    useEffect(() => {
        setHighResSvgUrl(null);
        const canvas = canvasRef.current;
        if (canvas && initialBitmap) {
            canvas.width = initialBitmap.width;
            canvas.height = initialBitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(initialBitmap, 0, 0);
        }
    }, [initialBitmap]);
    useEffect(() => {
        let isCancelled = false; let objectUrl = null;
        const loadHighRes = async () => {
            try {
                const file = dc.app.vault.getAbstractFileByPath(highResPath);
                if (!file) return;
                const svgText = await dc.app.vault.read(file);
                const blob = new Blob([svgText], { type: 'image/svg+xml' });
                objectUrl = URL.createObjectURL(blob);
                if (!isCancelled) { setHighResSvgUrl(objectUrl); }
            } catch (err) { console.error("Failed to load high-res image:", err); }
        };
        loadHighRes();
        return () => { isCancelled = true; if (objectUrl) { URL.revokeObjectURL(objectUrl); } };
    }, [highResPath]);
    const isFinal = !!highResSvgUrl;
    return (
        <div className="progressive-image-container">
            <img src={lowResSrc} alt={alt} className="panel-img low-res" style={{ opacity: isFinal ? 0 : 1 }} />
            <canvas ref={canvasRef} className="panel-img med-res" style={{ opacity: isFinal ? 0 : 1 }} />
            {highResSvgUrl && (<img src={highResSvgUrl} alt={alt} className="panel-img high-res" style={{ opacity: isFinal ? 1 : 0 }} />)}
        </div>
    );
};

const ZoomableImage = ({ lowResUrl, initialBitmap, highResPath, alt }) => {
    const containerRef = useRef(null);
    const contentRef = useRef(null);
    const [scale, setScale] = useState(1);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const [panning, setPanning] = useState(false);
    const last = useRef({ x: 0, y: 0 });
    const MIN = 1, MAX = 8;
    useEffect(() => { setScale(1); setPos({ x: 0, y: 0 }); }, [highResPath]);
    useEffect(() => { if (contentRef.current) { contentRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${scale})`; } }, [scale, pos]);
    const zoomAt = (factor, cx, cy) => {
        const rect = containerRef.current.getBoundingClientRect();
        const mx = cx === undefined ? rect.width / 2 : cx - rect.left;
        const my = cy === undefined ? rect.height / 2 : cy - rect.top;
        const prev = scale; const next = Math.max(MIN, Math.min(MAX, prev * factor)); const s = next / prev;
        const dx = (pos.x - (mx - rect.width / 2)) * s + (mx - rect.width / 2);
        const dy = (pos.y - (my - rect.height / 2)) * s + (my - rect.height / 2);
        setScale(next); setPos({ x: dx, y: dy });
    };
    const onWheel = (e) => { e.preventDefault(); if (e.ctrlKey || e.metaKey) { const factor = Math.exp(-e.deltaY * 0.0015); zoomAt(factor, e.clientX, e.clientY); } else { setPos((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY })); } };
    const onPointerDown = (e) => { if (e.target.closest('button')) return; setPanning(true); last.current = { x: e.clientX, y: e.clientY }; containerRef.current.setPointerCapture?.(e.pointerId); };
    const onPointerMove = (e) => { if (!panning) return; const dx = e.clientX - last.current.x; const dy = e.clientY - last.current.y; last.current = { x: e.clientX, y: e.clientY }; setPos((p) => ({ x: p.x + dx, y: p.y + dy })); };
    const onPointerUp = (e) => { if (!panning) return; setPanning(false); containerRef.current.releasePointerCapture?.(e.pointerId); };
    const handleZoomIn = (e) => { e.stopPropagation(); zoomAt(1.4); };
    const handleZoomOut = (e) => { e.stopPropagation(); zoomAt(1 / 1.4); };
    const handleReset = (e) => { e.stopPropagation(); setScale(1); setPos({ x: 0, y: 0 }); };
    return (
        <div ref={containerRef} className="zoom-container" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={(e) => zoomAt(1.5, e.clientX, e.clientY)}>
            <div ref={contentRef} className="zoom-content-wrapper">
                <ProgressiveImage lowResSrc={lowResUrl} initialBitmap={initialBitmap} highResPath={highResPath} alt={alt} />
            </div>
            <div className="zoom-controls">
                <button className="panel-icon-btn" onClick={handleZoomOut} title="Zoom Out"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
                <button className="panel-icon-btn" onClick={handleReset} title="Reset Zoom"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" /></svg></button>
                <button className="panel-icon-btn" onClick={handleZoomIn} title="Zoom In"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>
            </div>
        </div>
    );
};


const viewStyling = `
/* --- STYLES --- */
@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
@keyframes slideInRight {
    from { 
        opacity: 0;
        transform: translateX(100px);
    }
    to { 
        opacity: 1;
        transform: translateX(0);
    }
}
.tags-panel { position: absolute; top: 110%; left: 0; max-height: 300px; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 8px; width: 400px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); backdrop-filter: blur(10px); border-radius: 8px; padding: 12px; z-index: 20; }
.tag-btn { all: unset; box-sizing: border-box; cursor: pointer; padding: 6px 12px; border-radius: 14px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); color: var(--text-normal); font-size: 13px; transition: all .2s; }
.tag-btn:hover { background: var(--interactive-accent); color: var(--text-on-accent, white); }
.tag-btn-toggle.active { color: var(--text-accent, #87ffc5); background: rgba(135, 255, 197, 0.15); box-shadow: 0 0 8px rgba(135, 255, 197, 0.5); }
.full-tab-wrapper { position: relative; height: 100%; width: 100%; background: var(--background-primary); border-radius: 10px; overflow: hidden; }
.mini-canvas-wrapper { position: relative; height: 650px; width: 100%; background: var(--background-primary); border-radius: 10px; overflow: hidden; border: 1px solid var(--background-modifier-border); }
.fullscreen-toggle-btn { 
    all: unset; 
    box-sizing: border-box;
    position: absolute; 
    top: 14px; 
    right: 18px; 
    color: var(--text-muted); 
    cursor: pointer; 
    opacity: 0.5; 
    transform: scale(.95); 
    transition: all .2s; 
    z-index: 10; 
    pointer-events: auto;
    padding: 6px;
    display: grid;
    place-items: center;
}
.fullscreen-toggle-btn:hover { opacity: 1; transform: scale(1); color: var(--text-normal); }
.interactive-canvas { display: block; width: 100%; height: 100%; cursor: default; touch-action: none; background-color: var(--background-primary); }
.overlay { position: absolute; inset: 0; pointer-events: none; }
.subtle-icon { position: absolute; top: 14px; right: 18px; color: var(--text-muted); cursor: pointer; opacity: 0.5; transform: scale(.95); transition: all .2s; z-index: 10; pointer-events: auto; }
.full-tab-wrapper:hover .subtle-icon { opacity: 1; transform: scale(1); }
.fullscreen-active { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 9998; }
.panel-wrap { box-sizing: border-box; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(12px) saturate(1.2); pointer-events: auto; animation: fadeIn 0.4s cubic-bezier(0.25, 1, 0.5, 1); z-index: 100; padding: 2.5rem; }
.panel { display: flex; flex-direction: column; width: min(100%, 95vw); max-width: 1200px; height: min(100%, 90vh); background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 16px; box-shadow: 0 0 80px -20px var(--background-modifier-border); animation: scaleIn 0.4s cubic-bezier(0.25, 1, 0.5, 1); overflow: hidden; }
.panel-img-box { flex-grow: 1; position: relative; background: radial-gradient(circle at 50% 50%, rgba(255,255,255,0.03), transparent 70%); }
.panel-img { display: block; width: 100%; height: 100%; object-fit: contain; }
.theme-light .assets-library-container:not(.disable-color-invert) .panel-img { filter: invert(1); }
.panel-controls { display: flex; align-items: center; gap: 16px; padding: 12px 24px; border-top: 1px solid var(--background-modifier-border); flex-shrink: 0; }
.panel-info { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.panel-title { font-size: 16px; font-weight: 600; color: var(--text-normal); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-row { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-tags { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; }
.panel-tag { background: var(--background-primary-alt); color: var(--text-muted); padding: 3px 8px; font-size: 11px; border-radius: 10px; font-weight: 500; }
.btn-group { display: flex; gap: 10px; }
.panel-icon-btn { all: unset; box-sizing: border-box; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--background-primary-alt); color: var(--text-muted); cursor: pointer; transition: all 0.2s; }
.panel-icon-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.panel-icon-btn.danger:hover { color: #ff8080; }
.panel-icon-btn.active { color: var(--text-accent, #87ffc5); }
.compact-wrapper { padding: 16px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; border: 1px dashed var(--background-modifier-border); border-radius: 8px; background-color: var(--background-primary-alt); }
.compact-controls .btn { padding: 10px 14px; font-size: 12px; border-radius: 12px; border: 1px solid var(--background-modifier-border); background: var(--background-secondary); color: var(--text-normal); }
.compact-controls .btn.ghost { border-color: var(--background-modifier-border); background: transparent; color: var(--text-muted); }
.zoom-container { position: relative; width: 100%; height: 100%; overflow: hidden; cursor: grab; }
.zoom-container:active { cursor: grabbing; }
.zoom-content-wrapper { width: 100%; height: 100%; will-change: transform; transform-origin: center center; position: relative; }
.zoom-controls { position: absolute; right: 16px; bottom: 16px; display: flex; gap: 8px; pointer-events: auto; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 20px; padding: 4px; backdrop-filter: blur(8px); }
.progressive-image-container { width: 100%; height: 100%; }
.progressive-image-container .panel-img { position: absolute; top:0; left:0; width:100%; height:100%; will-change: opacity; transition: opacity 0.4s ease-in-out; padding: 16px; box-sizing: border-box; }
.progressive-image-container .low-res { filter: blur(12px); transform: scale(1.05); }
.progressive-image-container .med-res { object-fit: contain; }
.progressive-image-container .high-res { opacity: 0; }
@keyframes glow-animation { 0% { box-shadow: 0 0 8px rgba(170, 130, 255, 0.4); } 50% { box-shadow: 0 0 16px rgba(170, 130, 255, 0.7); } 100% { box-shadow: 0 0 8px rgba(170, 130, 255, 0.4); } }
.image-gallery-searchbar { position: absolute; top: 0; left: 0; display: flex; align-items: center; gap: 8px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); backdrop-filter: blur(10px); z-index: 10; touch-action: none; user-select: none; pointer-events: auto; border-radius: 22px; padding: 6px 8px; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s, border-radius 0.3s, box-shadow 0.3s, height 0.3s; }
.image-gallery-searchbar.collapsed { width: 40px; height: 40px; box-sizing: border-box; cursor: pointer; animation: glow-animation 3s infinite ease-in-out; padding: 4px; }
.image-gallery-searchbar.collapsed:hover { box-shadow: 0 0 18px var(--interactive-accent); animation-play-state: paused; }
.image-gallery-searchbar > * { transition: opacity 0.2s, width 0.3s cubic-bezier(0.4, 0, 0.2, 1), transform 0.3s; }
.image-gallery-searchbar .action-menu-icon { color: var(--text-muted); flex-shrink: 0; cursor: move; box-sizing: border-box; width: 32px; height: 32px; display: grid; place-items: center; }
.image-gallery-searchbar.collapsed .action-menu-icon { color: var(--text-normal); width: 100%; height: 100%; }
.image-gallery-searchbar input { all: unset; width: 120px; color: var(--text-normal); cursor: text; user-select: text; padding: 0 4px; }
.image-gallery-searchbar.collapsed > *:not(.action-menu-icon) { width: 0; opacity: 0; pointer-events: none; white-space: nowrap; transform: scaleX(0); margin-left: -8px; }
.image-gallery-searchbar .clear-btn { all: unset; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--background-primary-alt); color: var(--text-muted); cursor: pointer; }
.image-gallery-searchbar .select-btn { all: unset; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--background-primary-alt); color: var(--text-muted); cursor: pointer; transition: all 0.2s; }
.image-gallery-searchbar .select-btn:hover { background: var(--background-modifier-hover); }
.image-gallery-searchbar .select-btn.active { color: var(--text-accent, #87ffc5); background: rgba(135, 255, 197, 0.15); box-shadow: 0 0 8px rgba(135, 255, 197, 0.5); }
.search-bar-divider { width: 1px; height: 18px; background: var(--background-modifier-border); margin: 0 4px; }
.dropdown-container, .dropdown-menu, .select-btn { pointer-events: auto; }
.dropdown-container { position: relative; }
.dropdown-btn { all: unset; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 16px; background: var(--background-primary-alt); color: var(--text-muted); cursor: pointer; transition: all .2s; }
.dropdown-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.dropdown-menu { position: absolute; top: 110%; left: 0; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); backdrop-filter: blur(10px); border-radius: 8px; padding: 6px; z-index: 20; min-width: 180px; }
.dropdown-item { padding: 8px 12px; border-radius: 6px; cursor: pointer; color: var(--text-muted); font-size: 13px; }
.dropdown-item.with-icon { display: flex; align-items: center; gap: 8px; }
.dropdown-item:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.dropdown-item.active { background: var(--interactive-accent); color: var(--text-on-accent, white); font-weight: 500; }
.search-no-results { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 12px 20px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; color: var(--text-normal); z-index: 5; }
.mass-edit-panel { position: absolute; bottom: 40px; right: 40px; width: 320px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 10px; backdrop-filter: blur(12px); z-index: 20; pointer-events: auto; animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1); color: var(--text-normal); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25), 0 0 30px var(--background-modifier-border); }
.mass-edit-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--background-modifier-border); }
.mass-edit-header h3 { margin: 0; font-size: 16px; color: var(--text-normal); }
.mass-edit-header .close-btn { all: unset; cursor: pointer; font-size: 20px; color: var(--text-muted); }
.mass-edit-header .close-btn:hover { color: var(--text-normal); }
.mass-edit-body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.mass-edit-section p { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
.input-group { margin-bottom: 12px; }
.input-group label, .mass-edit-section > label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.input-group input { width: 100%; box-sizing: border-box; background: var(--background-primary); border: 1px solid var(--background-modifier-border); color: var(--text-normal); padding: 8px; border-radius: 4px; }
.input-group input:focus { border-color: var(--interactive-accent); outline: none; }
.mass-edit-presets { display: flex; gap: 10px; flex-wrap: wrap; }
.preset-btn { all: unset; box-sizing: border-box; cursor: pointer; padding: 6px 12px; border-radius: 14px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); color: var(--text-normal); font-size: 13px; transition: all .2s; }
.preset-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.mass-edit-divider { height: 1px; background: var(--background-modifier-border); margin: 8px 0; }
.mass-edit-footer { display: flex; justify-content: flex-end; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--background-modifier-border); }
.mass-edit-footer .btn { all: unset; box-sizing: border-box; cursor: pointer; padding: 8px 16px; border-radius: 6px; background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); color: var(--text-normal); transition: all 0.2s; font-weight: 500; text-align: center; }
.mass-edit-footer .btn:hover { background: var(--background-modifier-hover); }
.mass-edit-footer .btn:disabled { background: var(--background-modifier-border); color: var(--text-muted); cursor: not-allowed; }
.mass-edit-footer .btn.ghost { background: transparent; border: 1px solid var(--background-modifier-border); color: var(--text-muted); }
.mass-edit-footer .btn.ghost:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.mass-edit-panel .btn { background: var(--background-primary-alt); border: 1px solid var(--background-modifier-border); color: var(--text-normal); border-radius: 4px; padding: 4px 10px; cursor: pointer; transition: all 0.2s; }
.mass-edit-panel .btn:hover { background: var(--background-modifier-hover); }
.mass-edit-panel .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mass-edit-panel .btn.danger { background: #b71c1c; color: white; border: none; }
.mass-edit-panel .btn.danger:hover { background: #d32f2f; }
@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes scaleIn { from { transform: scale(.96); opacity: 0 } to { transform: scale(1); opacity: 1 } }

/* -- Settings Modal Styles -- */
.settings-modal-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    animation: fadeIn 0.2s ease-out;
}
.settings-modal-card {
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 16px;
    width: min(600px, 95vw);
    height: min(520px, 85vh);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.9);
    animation: scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    overflow: hidden;
    color: var(--text-normal);
    font-family: monospace;
}
.settings-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 18px 24px;
    border-bottom: 1px solid var(--background-modifier-border);
}
.settings-modal-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 400;
    color: var(--text-normal);
    letter-spacing: 0.5px;
}
.settings-modal-close {
    all: unset;
    cursor: pointer;
    font-size: 24px;
    color: var(--text-muted);
    transition: all 0.2s;
    background: transparent !important;
    border: none !important;
    outline: none !important;
    padding: 2px 8px !important;
    margin: 0 !important;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
}
.settings-modal-close:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover) !important;
}
.settings-modal-body {
    padding: 24px 24px 40px 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 24px;
}
.settings-modal-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.settings-modal-section h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--interactive-accent);
    text-transform: uppercase;
    letter-spacing: 1px;
}
.settings-modal-section p {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
}
.settings-folder-list {
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 160px;
    overflow-y: auto;
}
.settings-folder-empty {
    padding: 16px;
    text-align: center;
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
}
.settings-folder-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--background-primary-alt);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
}
.settings-folder-path {
    font-size: 12px;
    color: var(--text-normal);
    font-family: monospace;
}
.settings-folder-remove-btn {
    all: unset;
    cursor: pointer;
    color: rgba(255, 100, 100, 0.7);
    transition: color 0.2s;
    display: flex;
    align-items: center;
}
.settings-folder-remove-btn:hover {
    color: rgba(255, 80, 80, 0.9);
}
.settings-add-folder-form {
    display: flex;
    gap: 8px;
}
.settings-add-folder-form input {
    flex: 1;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    padding: 8px 12px;
    font-family: monospace;
    font-size: 12px;
    color: var(--text-normal);
    outline: none;
}
.settings-add-folder-form input:focus {
    border-color: var(--interactive-accent);
}
.settings-add-folder-btn {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    background: var(--background-secondary);
    border: 1px solid var(--interactive-accent);
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 12px;
    color: var(--text-normal);
    transition: all 0.2s;
}
.settings-add-folder-btn:hover {
    background: var(--interactive-accent);
    color: var(--text-on-accent, white);
}
.settings-grid-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}
.settings-form-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.settings-form-col label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.settings-form-col input {
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
    padding: 8px 12px;
    font-family: monospace;
    font-size: 12px;
    color: var(--text-normal);
    outline: none;
}
.settings-form-col input:focus {
    border-color: var(--interactive-accent);
}
.settings-modal-footer {
    padding: 18px 24px;
    border-top: 1px solid var(--background-modifier-border);
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    background: var(--background-secondary-alt);
}
.settings-modal-btn {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    padding: 8px 20px;
    border-radius: 6px;
    background: var(--interactive-accent);
    border: 1px solid var(--interactive-accent);
    color: var(--text-on-accent, white);
    font-size: 13px;
    transition: all 0.2s;
}
.settings-modal-btn:hover {
    background: var(--interactive-accent-hover);
}
.settings-modal-btn.ghost {
    background: transparent;
    border: 1px solid var(--background-modifier-border);
    color: var(--text-muted);
}
.settings-modal-btn.ghost:hover {
    color: var(--text-normal);
    border-color: var(--background-modifier-border);
    background: var(--background-modifier-hover);
}
`;

const SettingsModal = ({ config, onSave, onClose, folderPath }) => {
    // Parse the comma-separated folders into an array for UI display
    const [folders, setFolders] = useState(() => {
        return (config.localPath || "")
            .split(/[,,;]/)
            .map(p => p.trim())
            .filter(Boolean);
    });
    const [newFolderInput, setNewFolderInput] = useState("");
    const [vaultFolders, setVaultFolders] = useState([]);
    const [showCustomGithub, setShowCustomGithub] = useState(false);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [disableColorInvert, setDisableColorInvert] = useState(!!config.disableColorInvert);
    const [activeTab, setActiveTab] = useState('folders');
    
    // Multiple repos settings
    const [repos, setRepos] = useState(() => {
        if (config.repos && config.repos.length > 0) {
            return config.repos;
        }
        if (config.repoOwner && config.repoName) {
            return [{
                repoOwner: config.repoOwner,
                repoName: config.repoName,
                branch: config.branch || "main",
                assetsPath: config.assetsPath || ""
            }];
        }
        return [];
    });
    const [initialRepos] = useState(repos);

    const [githubUrlInput, setGithubUrlInput] = useState("");
    const [parsedRepos, setParsedRepos] = useState([]);

    const parseGithubUrls = (input) => {
        const urls = input.split(/[\n,;]+/).map(u => u.trim()).filter(Boolean);
        const results = [];
        for (const url of urls) {
            try {
                const cleaned = url.replace(/\/$/, "");
                const match = cleaned.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/(?:tree|blob)\/([^\/]+)\/(.+))?/i);
                if (match) {
                    results.push({
                        repoOwner: match[1],
                        repoName: match[2],
                        branch: match[3] || "main",
                        assetsPath: match[4] || ""
                    });
                }
            } catch (e) {
                console.error("Failed to parse GitHub URL:", url, e);
            }
        }
        return results;
    };

    const handleUrlChange = (val) => {
        setGithubUrlInput(val);
        const parsed = parseGithubUrls(val);
        setParsedRepos(parsed);
    };

    const handleAddRepo = () => {
        if (parsedRepos.length > 0) {
            let newRepos = [...repos];
            parsedRepos.forEach(parsed => {
                const exists = newRepos.some(r => r.repoOwner.toLowerCase() === parsed.repoOwner.toLowerCase() && r.repoName.toLowerCase() === parsed.repoName.toLowerCase() && (r.assetsPath || "").toLowerCase() === (parsed.assetsPath || "").toLowerCase());
                if (!exists) {
                    newRepos.push(parsed);
                }
            });
            setRepos(newRepos);
            setGithubUrlInput("");
            setParsedRepos([]);
        }
    };

    const handleRemoveRepo = (idxToRemove) => {
        setRepos(repos.filter((_, idx) => idx !== idxToRemove));
    };

    useEffect(() => {
        try {
            const files = dc.app.vault.getFiles() || [];
            const folderPaths = new Set();
            files.forEach(f => {
                let isAsset = false;
                if (f.path.endsWith('.svg') || f.path.endsWith('.excalidraw.md')) {
                    isAsset = true;
                } else if (f.extension === 'md') {
                    const cache = dc.app.metadataCache.getFileCache(f);
                    const frontmatter = cache?.frontmatter || {};
                    
                    // Check tags or excalidraw config keys
                    const tags = frontmatter.tags || frontmatter.tag || [];
                    const tagsArr = Array.isArray(tags) ? tags : [tags];
                    const hasTag = tagsArr.some(t => String(t).toLowerCase().includes('excalidraw'));
                    const isExcalidraw = !!frontmatter.excalidraw || !!frontmatter['excalidraw-plugin'] || hasTag;
                    
                    if (isExcalidraw) {
                        isAsset = true;
                    }
                }

                if (isAsset) {
                    const parts = f.path.split('/');
                    if (parts.length > 1) {
                        parts.pop(); // remove file name
                        folderPaths.add(parts.join('/'));
                    }
                }
            });
            const sortedFolders = Array.from(folderPaths).sort((a, b) => a.localeCompare(b));
            setVaultFolders(sortedFolders.slice(0, 100)); // Cap at 100 to prevent any DOM overload
        } catch (e) {
            console.error("Failed to load vault folders list:", e);
        }
    }, []);

    const handleAddFolder = () => {
        const path = newFolderInput.trim();
        if (path && !folders.includes(path)) {
            setFolders([...folders, path]);
            setNewFolderInput("");
        }
    };

    const handleRemoveFolder = (indexToRemove) => {
        setFolders(folders.filter((_, idx) => idx !== indexToRemove));
    };

    const handleSave = () => {
        // Only trigger sync if a new repository was added that wasn't there before
        const hasNewRepo = repos.some(r => {
            const wasPresent = initialRepos.some(init => 
                init.repoOwner.toLowerCase() === r.repoOwner.toLowerCase() &&
                init.repoName.toLowerCase() === r.repoName.toLowerCase() &&
                (init.assetsPath || "").toLowerCase() === (r.assetsPath || "").toLowerCase()
            );
            return !wasPresent;
        });

        onSave({
            repoOwner: repos[0]?.repoOwner || "",
            repoName: repos[0]?.repoName || "",
            branch: repos[0]?.branch || "main",
            assetsPath: repos[0]?.assetsPath || "",
            localPath: folders.join(", "),
            repos,
            disableColorInvert
        }, hasNewRepo);
    };

    return (
        <div className="settings-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="settings-modal-card" onClick={e => e.stopPropagation()}>
                <div className="settings-modal-header">
                    <h3>Configure Library & Folders</h3>
                    <button className="settings-modal-close" onClick={onClose}>×</button>
                </div>
                
                <div className="settings-tabs" style={{ display: 'flex', borderBottom: '1px solid var(--background-modifier-border)', background: 'var(--background-secondary-alt)', padding: '0 24px' }}>
                    <button 
                        onClick={() => setActiveTab('folders')} 
                        style={{ 
                            background: 'none', 
                            border: 'none', 
                            borderBottom: activeTab === 'folders' ? '2px solid var(--interactive-accent)' : '2px solid transparent',
                            color: activeTab === 'folders' ? 'var(--text-normal)' : 'var(--text-muted)',
                            padding: '12px 16px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: activeTab === 'folders' ? 'bold' : 'normal',
                            transition: 'all 0.2s',
                            marginRight: '8px'
                        }}
                    >
                        Vault Folders
                    </button>
                    <button 
                        onClick={() => setActiveTab('display')} 
                        style={{ 
                            background: 'none', 
                            border: 'none', 
                            borderBottom: activeTab === 'display' ? '2px solid var(--interactive-accent)' : '2px solid transparent',
                            color: activeTab === 'display' ? 'var(--text-normal)' : 'var(--text-muted)',
                            padding: '12px 16px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: activeTab === 'display' ? 'bold' : 'normal',
                            transition: 'all 0.2s',
                            marginRight: '8px'
                        }}
                    >
                        Display Settings
                    </button>
                    <button 
                        onClick={() => setActiveTab('sync')} 
                        style={{ 
                            background: 'none', 
                            border: 'none', 
                            borderBottom: activeTab === 'sync' ? '2px solid var(--interactive-accent)' : '2px solid transparent',
                            color: activeTab === 'sync' ? 'var(--text-normal)' : 'var(--text-muted)',
                            padding: '12px 16px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: activeTab === 'sync' ? 'bold' : 'normal',
                            transition: 'all 0.2s'
                        }}
                    >
                        GitHub Sync
                    </button>
                </div>
                
                <div className="settings-modal-body">
                    {activeTab === 'folders' && (
                        <div className="settings-modal-section">
                            <h4>Local Vault Folders</h4>
                            <p>Manage folders in your vault that contain drawings/SVGs. The canvas will load assets from all of them collectively.</p>
                            
                            <div className="settings-folder-list">
                                {folders.length === 0 ? (
                                    <div className="settings-folder-empty">No folders configured. Add one below.</div>
                                ) : (
                                    folders.map((folder, idx) => (
                                        <div key={folder} className="settings-folder-row">
                                            <span className="settings-folder-path">{folder}</span>
                                            <button className="settings-folder-remove-btn" onClick={() => handleRemoveFolder(idx)} title="Remove folder">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="3 6 5 6 21 6"></polyline>
                                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                                </svg>
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                            
                            <div className="settings-add-folder-form" style={{ display: 'flex', flexDirection: 'column', gap: '10px', position: 'relative' }}>
                                <div style={{ display: 'flex', gap: '10px' }}>
                                    <div style={{ flexGrow: 1, position: 'relative' }}>
                                        <input 
                                            type="text" 
                                            placeholder="Choose or type folder (e.g. folder/assets)" 
                                            value={newFolderInput} 
                                            onChange={(e) => {
                                                setNewFolderInput(e.target.value);
                                                setShowSuggestions(true);
                                            }}
                                            onFocus={() => setShowSuggestions(true)}
                                            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                                            onKeyDown={(e) => { 
                                                if (e.key === 'Enter') { 
                                                    e.preventDefault(); 
                                                    handleAddFolder(); 
                                                    setShowSuggestions(false);
                                                } 
                                            }}
                                            style={{ width: '100%', background: 'var(--background-primary)', border: '1px solid var(--background-modifier-border)', borderRadius: '6px', color: 'var(--text-normal)', padding: '8px', fontFamily: 'monospace' }}
                                        />
                                        {showSuggestions && vaultFolders.filter(path => !newFolderInput || path.toLowerCase().includes(newFolderInput.toLowerCase())).length > 0 && (
                                            <div 
                                                style={{ 
                                                    position: 'absolute', 
                                                    top: '100%', 
                                                    left: 0, 
                                                    right: 0, 
                                                    background: 'var(--background-secondary)', 
                                                    border: '1px solid var(--background-modifier-border)', 
                                                    borderRadius: '6px', 
                                                    maxHeight: '150px', 
                                                    overflowY: 'auto', 
                                                    zIndex: 10000, 
                                                    marginTop: '4px',
                                                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
                                                }}
                                            >
                                                {vaultFolders
                                                    .filter(path => !newFolderInput || path.toLowerCase().includes(newFolderInput.toLowerCase()))
                                                    .map(path => (
                                                        <div 
                                                            key={path} 
                                                            onClick={() => {
                                                                setNewFolderInput(path);
                                                                setShowSuggestions(false);
                                                            }}
                                                            style={{ 
                                                                padding: '8px 12px', 
                                                                cursor: 'pointer', 
                                                                color: 'var(--text-muted)', 
                                                                fontSize: '11px',
                                                                fontFamily: 'monospace',
                                                                borderBottom: '1px solid var(--background-modifier-border)'
                                                            }}
                                                            onMouseEnter={(e) => {
                                                                e.target.style.background = 'var(--background-modifier-hover)';
                                                                e.target.style.color = 'var(--text-normal)';
                                                            }}
                                                            onMouseLeave={(e) => {
                                                                e.target.style.background = 'transparent';
                                                                e.target.style.color = 'var(--text-muted)';
                                                            }}
                                                        >
                                                            {path}
                                                        </div>
                                                    ))}
                                            </div>
                                        )}
                                    </div>
                                    <button className="settings-add-folder-btn" onClick={() => { handleAddFolder(); setShowSuggestions(false); }} style={{ flexShrink: 0 }}>Add Folder</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'display' && (
                        <div className="settings-modal-section">
                            <h4>Display Settings</h4>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                                <input 
                                    type="checkbox" 
                                    id="disableColorInvertCheckbox" 
                                    checked={disableColorInvert} 
                                    onChange={(e) => setDisableColorInvert(e.target.checked)}
                                    style={{ width: '16px', height: '16px', accentColor: 'var(--interactive-accent)', cursor: 'pointer' }}
                                />
                                <label htmlFor="disableColorInvertCheckbox" style={{ fontSize: '12px', color: 'var(--text-normal)', cursor: 'pointer', userSelect: 'none' }}>
                                    Disable light mode drawing color inversion (keep original white lines in light mode)
                                </label>
                            </div>
                        </div>
                    )}

            {activeTab === 'sync' && (
                <div className="settings-modal-section">
                    <h4>GitHub Synchronization</h4>
                        <p style={{ marginBottom: '12px' }}>Configure remote sources to fetch drawings directly into your first configured local folder.</p>
                        
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <button 
                                className="settings-modal-btn" 
                                onClick={() => {
                                    let currentFolders = [...folders];
                                    if (currentFolders.length === 0) {
                                        const defaultFolder = folderPath ? `${folderPath.replace(/\/[^\/]+\.md$/, '')}/assets` : FOLDER_PATH;
                                        currentFolders = [defaultFolder];
                                    }
                                    const betoRepo = {
                                        repoOwner: "beto-group",
                                        repoName: "beto.assets",
                                        branch: "main",
                                        assetsPath: "ASSETS"
                                    };
                                    let finalRepos = [...repos];
                                    const exists = finalRepos.some(r => r.repoOwner.toLowerCase() === "beto-group" && r.repoName.toLowerCase() === "beto.assets");
                                    if (!exists) {
                                        finalRepos.push(betoRepo);
                                    }
                                    onSave({
                                        ...config,
                                        repoOwner: "beto-group",
                                        repoName: "beto.assets",
                                        branch: "main",
                                        assetsPath: "ASSETS",
                                        localPath: currentFolders.join(", "),
                                        repos: finalRepos,
                                        disableColorInvert
                                    }, true);
                                }}
                                style={{
                                    background: 'var(--interactive-accent)',
                                    border: 'none',
                                    padding: '10px 14px',
                                    borderRadius: '6px',
                                    color: 'var(--text-on-accent, #fff)',
                                    fontWeight: 'bold',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '8px'
                                }}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                                </svg>
                                Sync BETO.GROUP Official Assets
                            </button>
                            
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4', background: 'var(--background-primary-alt)', padding: '10px', borderRadius: '6px', border: '1px solid var(--background-modifier-border)' }}>
                                <strong>What is this?</strong> Syncs official BETO vector libraries (SVG drawings & icons) from the <code>beto-group/beto.assets</code> GitHub repository. Files are saved directly to your first configured local folder.
                            </div>

                            <div className="settings-folder-list">
                                {repos.length === 0 ? (
                                    <div className="settings-folder-empty">No GitHub repositories configured. Add one below.</div>
                                ) : (
                                    repos.map((repo, idx) => (
                                        <div key={idx} className="settings-folder-row" style={{ fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' }}>
                                                <span style={{ fontWeight: 'bold', color: 'var(--text-normal)' }}>{repo.repoOwner}/{repo.repoName}</span>
                                                <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>Branch: {repo.branch} | Path: {repo.assetsPath || '(root)'}</span>
                                            </div>
                                            <button className="settings-folder-remove-btn" onClick={() => handleRemoveRepo(idx)} title="Remove Repository">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="3 6 5 6 21 6"></polyline>
                                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                                </svg>
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                            
                            <div style={{ marginTop: '5px' }}>
                                <button 
                                    onClick={() => setShowCustomGithub(!showCustomGithub)}
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        color: 'var(--interactive-accent)',
                                        fontSize: '11px',
                                        cursor: 'pointer',
                                        padding: 0,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px'
                                    }}
                                >
                                    {showCustomGithub ? 'Hide' : 'Add'} Custom GitHub Repository...
                                </button>
                                {showCustomGithub && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px', animation: 'fadeIn 0.2s' }}>
                                        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                                            <textarea 
                                                placeholder="Enter GitHub URL(s) (one per line, or comma-separated)&#13;&#10;e.g. https://github.com/owner/repo/tree/branch/subfolder" 
                                                value={githubUrlInput} 
                                                onChange={(e) => handleUrlChange(e.target.value)} 
                                                rows={3}
                                                style={{ flexGrow: 1, background: 'var(--background-primary)', border: '1px solid var(--background-modifier-border)', color: 'var(--text-normal)', padding: '8px', borderRadius: '6px', fontFamily: 'monospace', resize: 'vertical' }} 
                                            />
                                            <button 
                                                className="settings-add-folder-btn" 
                                                onClick={handleAddRepo}
                                                style={{ flexShrink: 0, height: '38px' }}
                                                disabled={parsedRepos.length === 0}
                                            >
                                                {parsedRepos.length > 1 ? `Add ${parsedRepos.length} Repos` : 'Add Repo'}
                                            </button>
                                        </div>
                                        {parsedRepos.length > 0 && (
                                            <div style={{ fontSize: '10px', color: '#888', padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                <strong style={{ color: '#aaa', marginBottom: '2px' }}>Parsed Repositories ({parsedRepos.length}):</strong>
                                                {parsedRepos.map((r, i) => (
                                                    <div key={i} style={{ display: 'flex', gap: '10px' }}>
                                                        <span><strong>Owner:</strong> {r.repoOwner}</span>
                                                        <span><strong>Repo:</strong> {r.repoName}</span>
                                                        <span><strong>Branch:</strong> {r.branch}</span>
                                                        <span><strong>Path:</strong> {r.assetsPath || "(root)"}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

                <div className="settings-modal-footer">
                    <button className="settings-modal-btn ghost" onClick={onClose}>Cancel</button>
                    <button className="settings-modal-btn" onClick={handleSave}>Save Changes</button>
                </div>
            </div>
        </div>
    );
};

// --- 5. Main Component (Corrected and Integrated) ---

// DOM Traversal Utilities for Full-Tab Mode
function findNearestAncestorWithClass(element, className) {
    if (!element) return null;
    let current = element.parentNode;
    while (current) {
        if (current.classList && current.classList.contains(className)) {
            return current;
        }
        current = current.parentNode;
    }
    return null;
}

function findDirectChildByClass(parent, className) {
    if (!parent) return null;
    for (const child of parent.children) {
        if (child.classList && child.classList.contains(className)) {
            return child;
        }
    }
    return null;
}

// Full-Tab Effect Hook
function useFullscreenEffect(containerRef, isFullscreen) {
    const stateRefs = useRef({}).current;

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !isFullscreen) return;

        const targetPaneContent = findNearestAncestorWithClass(
            container,
            "workspace-leaf-content"
        );
        
        if (!targetPaneContent) {
            return;
        }

        const contentWrapper =
            findDirectChildByClass(targetPaneContent, "view-content") ||
            targetPaneContent;

        stateRefs.originalParent = container.parentNode;
        stateRefs.placeholder = document.createElement("div");
        stateRefs.placeholder.style.display = "none";
        container.parentNode.insertBefore(stateRefs.placeholder, container);

        stateRefs.parentPositionInfo = {
            element: contentWrapper,
            original: window.getComputedStyle(contentWrapper).position,
        };

        if (stateRefs.parentPositionInfo.original === "static") {
            contentWrapper.style.position = "relative";
        }

        contentWrapper.appendChild(container);

        Object.assign(container.style, {
            position: "absolute",
            top: "0",
            left: "0",
            width: "100%",
            height: "100%",
            zIndex: "9998",
            overflow: "auto",
        });

        return () => {
            if (stateRefs.placeholder?.parentNode) {
                stateRefs.placeholder.parentNode.replaceChild(
                    container,
                    stateRefs.placeholder
                );
            }
            if (stateRefs.parentPositionInfo?.element) {
                stateRefs.parentPositionInfo.element.style.position =
                    stateRefs.parentPositionInfo.original === "static"
                        ? ""
                        : stateRefs.parentPositionInfo.original;
            }
            container.removeAttribute("style");
            Object.keys(stateRefs).forEach((key) => (stateRefs[key] = null));
        };
    }, [isFullscreen]);
}

const AssetsLibrary = ({ folderPath }) => {
    // Get current file path to determine relative paths
    const currentFilePath = dc.useCurrentPath();
    const baseDir = useMemo(() => {
        if (currentFilePath) {
            return currentFilePath.substring(0, currentFilePath.lastIndexOf("/"));
        }
        return folderPath ? folderPath.replace(/\/[^\/]+\.md$/i, '') : "AssetsLibrary";
    }, [currentFilePath, folderPath]);

    const CONSENT_FILE_PATH = useMemo(() => `${baseDir}/data/config.json`, [baseDir]);
    
    useEffect(() => {
        if (baseDir) {
            Core.REMOVED_IMAGES_PATH = `${baseDir}/data/removed.json`;
        }
    }, [baseDir]);

    const ensureDirRecursive = async (path) => {
        const parts = path.split('/');
        let current = '';
        for (const part of parts) {
            if (!part) continue;
            current = current ? `${current}/${part}` : part;
            if (!(await dc.app.vault.adapter.exists(current))) {
                await dc.app.vault.adapter.mkdir(current);
            }
        }
    };

    // Default configuration values (dynamic local path defaults to components folder /assets)
    const [config, setConfig] = useState(() => ({
        repoOwner: GITHUB_REPO_OWNER,
        repoName: GITHUB_REPO_NAME,
        branch: GITHUB_BRANCH,
        assetsPath: GITHUB_ASSETS_PATH,
        localPath: baseDir ? `${baseDir}/assets` : FOLDER_PATH
    }));

    // Update config if baseDir resolves later
    useEffect(() => {
        setConfig(prev => {
            if (!prev.localPath || prev.localPath === FOLDER_PATH || prev.localPath.endsWith("/assets")) {
                return {
                    ...prev,
                    localPath: baseDir ? `${baseDir}/assets` : FOLDER_PATH
                };
            }
            return prev;
        });
    }, [baseDir]);

    const [isLightMode, setIsLightMode] = useState(document.body.classList.contains('theme-light'));

    useEffect(() => {
        const observer = new MutationObserver(() => {
            const currentLightMode = document.body.classList.contains('theme-light');
            setIsLightMode(currentLightMode);
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    // State now starts at null to indicate we're checking for consent
    const [hasConsented, setHasConsented] = useState(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [panel, setPanel] = useState(null);
    const [removedImages, setRemovedImages] = useState(new Set());
    const [searchTerm, setSearchTerm] = useState('');
    const [sortOption, setSortOption] = useState('path_asc');
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedPaths, setSelectedPaths] = useState(new Set());
    const [viewType, setViewType] = useState('grid');
    const [isFullscreen, setIsFullscreen] = useState(true);
    const [fileListVersion, setFileListVersion] = useState(0);
    const [resetViewKey, setResetViewKey] = useState(0);
    const [showSyncNotification, setShowSyncNotification] = useState(true);
    const [showConversionNotification, setShowConversionNotification] = useState(true);

    const [imageFiles, setImageFiles] = useState(null);
    const [potentialMdFileCount, setPotentialMdFileCount] = useState(0);

    const [isTransitioning, setIsTransitioning] = useState(false);
    const [transitionInitialPositions, setTransitionInitialPositions] = useState(null);
    const graphNodesRef = useRef(null);

    const containerRef = useRef(null);
    const searchInputRef = useRef(null);
    const interactingUntilRef = useRef(0);
    const onCacheUpdateRef = useRef(() => { });
    const hasAutoOpenedRef = useRef(false);

    // Apply full-tab effect when in fullscreen mode
    useFullscreenEffect(containerRef, isFullscreen);

    const { status: converterStatus, error: converterError, logs: converterLogs, runConversionCheck, converterDeps, conversionProgress, isConverting } = useExcalidrawConverter(currentFilePath, config, baseDir);
    
    // Initialize GitHub sync hook with converter dependencies and consent status
    const { syncStatus, syncProgress, syncLogs, syncError, syncFromGitHub, cancelSync } = useGitHubSync(converterStatus, converterDeps, hasConsented, CONSENT_FILE_PATH, currentFilePath, config);

    // Show notification when sync starts (must come after syncStatus is defined)
    useEffect(() => {
        if (syncStatus === 'syncing') {
            setShowSyncNotification(true);
        }
    }, [syncStatus]);

    // Show notification when conversion starts
    useEffect(() => {
        if (isConverting) {
            setShowConversionNotification(true);
        }
    }, [isConverting]);

    // Check for persisted consent status when the component mounts
    useEffect(() => {
        const checkConsent = async () => {
            try {
                if (await dc.app.vault.adapter.exists(CONSENT_FILE_PATH)) {
                    const content = await dc.app.vault.adapter.read(CONSENT_FILE_PATH);
                    const data = JSON.parse(content || "{}");
                    setHasConsented(true); // always true so they see the canvas immediately!
                    
                    let localPathParsed = data.localPath || "";
                    if (localPathParsed.includes(".md/")) {
                        localPathParsed = localPathParsed.replace(/\/[^\/]+\.md\/assets/, "/assets");
                        data.localPath = localPathParsed;
                        await dc.app.vault.adapter.write(CONSENT_FILE_PATH, JSON.stringify(data, null, 2));
                    }
                    const foldersList = localPathParsed.split(/[,,;]/).map(p => p.trim()).filter(Boolean);
                    
                    setConfig({
                        repoOwner: data.repoOwner || GITHUB_REPO_OWNER,
                        repoName: data.repoName || GITHUB_REPO_NAME,
                        branch: data.branch || GITHUB_BRANCH,
                        assetsPath: data.assetsPath || GITHUB_ASSETS_PATH,
                        localPath: localPathParsed,
                        repos: data.repos || []
                    });

                    // If no folders have been set up yet, pop up the settings modal immediately
                    if (foldersList.length === 0) {
                        setIsSettingsOpen(true);
                    }
                } else {
                    // Auto-consent and save defaults on first load so they bypass blocker screens
                    // We start localPath as empty so the user is prompted to add their vault folders
                    const defaultConfig = {
                        repoOwner: GITHUB_REPO_OWNER,
                        repoName: GITHUB_REPO_NAME,
                        branch: GITHUB_BRANCH,
                        assetsPath: GITHUB_ASSETS_PATH,
                        localPath: baseDir ? `${baseDir}/assets` : FOLDER_PATH
                    };
                    const dir = CONSENT_FILE_PATH.substring(0, CONSENT_FILE_PATH.lastIndexOf("/"));
                    if (!(await dc.app.vault.adapter.exists(dir))) {
                        await ensureDirRecursive(dir);
                    }
                    await dc.app.vault.adapter.write(CONSENT_FILE_PATH, JSON.stringify({ consented: true, ...defaultConfig }, null, 2));
                    setConfig(defaultConfig);
                    setHasConsented(true);
                    setIsSettingsOpen(true); // Popup automatically since config is empty
                }
            } catch (err) {
                console.error("Error checking consent status:", err);
                setHasConsented(true);
            }
        };
        checkConsent();
    }, [folderPath, baseDir, CONSENT_FILE_PATH]);

    // This function now saves the consent and custom config to a file and updates the state
    const handleConsent = async (customConfig) => {
        try {
            const dir = CONSENT_FILE_PATH.substring(0, CONSENT_FILE_PATH.lastIndexOf("/"));
            if (!(await dc.app.vault.adapter.exists(dir))) {
                await ensureDirRecursive(dir);
            }
            
            // Ensure local target folders exist in the vault
            const localDirs = (customConfig.localPath || "").split(/[,,;]/).map(p => p.trim()).filter(Boolean);
            for (const localDir of localDirs) {
                if (!(await dc.app.vault.adapter.exists(localDir))) {
                    await ensureDirRecursive(localDir);
                }
                const gitignorePath = `${localDir}/.gitignore`;
                if (!(await dc.app.vault.adapter.exists(gitignorePath))) {
                    await dc.app.vault.adapter.write(gitignorePath, "*\n!.gitignore\n");
                }
            }

            const consentData = {
                consented: true,
                ...customConfig
            };
            await dc.app.vault.adapter.write(CONSENT_FILE_PATH, JSON.stringify(consentData, null, 2));
            setConfig(customConfig);
            setHasConsented(true);
        } catch (err) {
            console.error("Error saving consent:", err);
            // Allow the user to proceed for the current session even if saving fails
            setConfig(customConfig);
            setHasConsented(true);
        }
    };


    // Trigger initial conversion check in parallel with file loading and GitHub sync
    useEffect(() => {
        if (!hasConsented) return;
        if (converterStatus === 'ready') {
            // Non-blocking - runs in background while canvas loads
            runConversionCheck((newFilesCreated) => {
                if (newFilesCreated) {
                    setFileListVersion(v => v + 1);
                }
            });
        }
    }, [converterStatus, runConversionCheck, hasConsented]);

    // Watch for file changes with debouncing to prevent duplicate triggers
    useEffect(() => {
        if (!hasConsented || converterStatus !== 'ready') return;
        
        let debounceTimer = null;
        const pendingFiles = new Set();
        
        const handleFileChange = (file) => {
            const paths = (config.localPath || (baseDir ? `${baseDir}/assets` : FOLDER_PATH)).split(/[,,;]/).map(p => p.trim()).filter(Boolean);
            if (paths.some(p => file.path.startsWith(p)) && file.extension === 'md') {
                // Add to pending set to deduplicate
                pendingFiles.add(file.path);
                
                // Clear existing timer
                if (debounceTimer) clearTimeout(debounceTimer);
                
                // Set new timer - only trigger once after 500ms of no changes
                debounceTimer = setTimeout(() => {
                    if (pendingFiles.size > 0) {
                        console.log(`Detected ${pendingFiles.size} file change(s), triggering conversion check.`);
                        pendingFiles.clear();
                        runConversionCheck((newFilesCreated) => {
                            if (newFilesCreated) {
                                setFileListVersion(v => v + 1);
                            }
                        });
                    }
                }, 500);
            }
        };
        
        const eventRef = dc.app.metadataCache.on('changed', handleFileChange);
        return () => {
            dc.app.metadataCache.offref(eventRef);
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    }, [converterStatus, runConversionCheck, hasConsented, config.localPath]);

    const sortOptions = [{ value: "path_asc", label: "Path (A-Z)" }, { value: "path_desc", label: "Path (Z-A)" }, { value: "name_asc", label: "Name (A-Z)" }, { value: "name_desc", label: "Name (Z-A)" }, { value: "mtime_desc", label: "Date Modified (Newest)" }, { value: "mtime_asc", label: "Date Modified (Oldest)" }, { value: "ctime_desc", label: "Date Created (Newest)" }, { value: "ctime_asc", label: "Date Created (Oldest)" }, { value: "size_desc", label: "Size (Largest)" }, { value: "size_asc", label: "Size (Smallest)" }];

    // Load files immediately and continuously update as sync/conversion completes
    useEffect(() => {
        if (!hasConsented) return;
        
        const loadFiles = async () => {
            try {
                const allFiles = dc.app.vault.getFiles();
                const paths = (config.localPath || (baseDir ? `${baseDir}/assets` : FOLDER_PATH)).split(/[,,;]/).map(p => p.trim()).filter(Boolean);
                const filesInPath = allFiles.filter(file => paths.some(p => file.path.startsWith(p)));

                const svgFiles = filesInPath.filter(file => file.extension === 'svg');
                const mdFiles = new Set(filesInPath.filter(f => f.extension === 'md').map(f => f.path.replace(/\.md$/i, '')));
                const svgBasePaths = new Set(svgFiles.map(f => f.path.replace(/\.svg$/i, '')));

                let potentialCount = 0;
                for (const mdBasePath of mdFiles) {
                    if (!svgBasePaths.has(mdBasePath)) {
                        potentialCount++;
                    }
                }
                setPotentialMdFileCount(potentialCount);
                
                // Only set files that actually exist on disk to avoid ENOENT errors
                const existingSvgFiles = [];
                for (const file of svgFiles) {
                    // Verify file actually exists before adding to list
                    try {
                        const exists = await dc.app.vault.adapter.exists(file.path);
                        if (exists) {
                            existingSvgFiles.push(file);
                        }
                    } catch (err) {
                        // Skip files that can't be verified
                        console.debug(`[Assets Library] Skipping unverified file: ${file.path}`);
                    }
                }
                setImageFiles(existingSvgFiles);
                if (existingSvgFiles.length === 0 && potentialCount === 0 && !hasAutoOpenedRef.current) {
                    hasAutoOpenedRef.current = true;
                    setIsSettingsOpen(true);
                }

            } catch (e) {
                console.error("[Image Gallery] CRITICAL ERROR during file search:", e);
                setImageFiles([]);
                setPotentialMdFileCount(0);
            }
        };
        
        // Load files immediately - doesn't wait for sync/conversion
        loadFiles();
    }, [fileListVersion, hasConsented, config.localPath]);

    const visibleImageFiles = useMemo(() => {
        if (!imageFiles) return [];
        if (!removedImages || removedImages.size === 0) return imageFiles;
        return imageFiles.filter(f => !removedImages.has(f.path));
    }, [imageFiles, removedImages]);

    const sortedAndVisibleImageFiles = useMemo(() => {
        const [key, direction] = sortOption.split('_');
        const sorted = [...visibleImageFiles];
        sorted.sort((a, b) => { let valA, valB; switch (key) { case 'mtime': valA = a.stat.mtime; valB = b.stat.mtime; break; case 'ctime': valA = a.stat.ctime; valB = b.stat.ctime; break; case 'size': valA = a.stat.size; valB = b.stat.size; break; case 'name': valA = a.basename.toLowerCase(); valB = b.basename.toLowerCase(); break; default: valA = a.path.toLowerCase(); valB = b.path.toLowerCase(); break; } if (typeof valA === 'string') { return direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA); } else { return direction === 'asc' ? valA - valB : valB - valA; } });
        return sorted;
    }, [visibleImageFiles, sortOption]);

    const [imageTagsMap, setImageTagsMap] = useState(new Map());
    useEffect(() => {
        if (!hasConsented) return;
        const timer = setTimeout(() => {
            const map = new Map();
            const pathToMdPath = (svgPath) => svgPath.replace(/\.svg$/i, '.md');
            const tagKeys = ['A888a', 'data-aaa-tags', 'tags'];
            for (const file of visibleImageFiles) {
                const mdPath = pathToMdPath(file.path);
                const mdFile = dc.app.vault.getAbstractFileByPath(mdPath);
                if (mdFile) {
                    const cache = dc.app.metadataCache.getFileCache(mdFile);
                    const fm = cache?.frontmatter;
                    if (fm) {
                        const fileTags = new Set();
                        tagKeys.forEach(key => {
                            const val = fm[key];
                            if (val) {
                                const tagsToAdd = Array.isArray(val) ? val : String(val).split(/, ?/);
                                tagsToAdd.forEach(tag => { if (typeof tag === 'string' && tag.trim()) fileTags.add(tag.trim()); });
                            }
                        });
                        if (fileTags.size > 0) map.set(file.path, Array.from(fileTags));
                    }
                }
            }
            setImageTagsMap(map);
        }, 100);
        return () => clearTimeout(timer);
    }, [visibleImageFiles, hasConsented]);

    const matchingImagePaths = useMemo(() => {
        if (!searchTerm) return new Set();
        const lowerCaseTerm = searchTerm.toLowerCase();
        const filtered = sortedAndVisibleImageFiles.filter(file => {
            if (file.path.toLowerCase().includes(lowerCaseTerm)) return true;
            const tags = imageTagsMap.get(file.path);
            if (tags) { return tags.some(tag => tag.toLowerCase().includes(lowerCaseTerm)); }
            return false;
        });
        return new Set(filtered.map(f => f.path));
    }, [sortedAndVisibleImageFiles, searchTerm, imageTagsMap]);

    const isSearching = searchTerm.length > 0;

    const { imageCache, requestImages, workerError, requestedSet } = useImageWorker(sortedAndVisibleImageFiles, () => onCacheUpdateRef.current());
    const bgQueueRef = useRef([]);
    const bgRunningRef = useRef(false);
    const cancelledRef = useRef(false);

    const startBackgroundPreload = useCallback(() => {
        if (bgRunningRef.current) return;
        bgRunningRef.current = true;
        cancelledRef.current = false;
        const schedule = (fn) => ('requestIdleCallback' in window) ? window.requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 200);
        const refill = () => {
            const queuedOrRequested = new Set([...bgQueueRef.current.map(f => f.path), ...requestedSet]);
            for (const f of sortedAndVisibleImageFiles) { if (!queuedOrRequested.has(f.path) && !imageCache.has(f.path)) { bgQueueRef.current.push(f); } }
        };
        const pump = async () => {
            if (cancelledRef.current) { bgRunningRef.current = false; return; }
            if (performance.now() < interactingUntilRef.current) { schedule(pump); return; }
            refill();
            const batch = [];
            while (bgQueueRef.current.length > 0 && batch.length < 24) {
                const f = bgQueueRef.current.shift();
                if (!f || imageCache.has(f.path) || requestedSet.has(f.path)) continue;
                batch.push(f);
            }
            if (batch.length > 0) requestImages(batch, false);
            if (bgQueueRef.current.length === 0 && Array.from(requestedSet).every(p => imageCache.has(p))) { bgRunningRef.current = false; return; }
            schedule(pump);
        };
        schedule(pump);
    }, [sortedAndVisibleImageFiles, requestImages, imageCache, requestedSet]);

    useEffect(() => {
        if (!hasConsented) return;
        startBackgroundPreload();
        const visListener = () => { if (document.visibilityState === 'visible') startBackgroundPreload(); };
        document.addEventListener('visibilitychange', visListener);
        return () => { cancelledRef.current = true; document.removeEventListener('visibilitychange', visListener); };
    }, [startBackgroundPreload, hasConsented]);

    const allUniqueTags = useMemo(() => {
        const tagSet = new Set();
        for (const tags of imageTagsMap.values()) {
            for (const tag of tags) { tagSet.add(tag); }
        }
        return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
    }, [imageTagsMap]);

    const pathToMdPath = (svgPath) => svgPath.replace(/\.svg$/i, '.md');
    const onCardClick = useCallback(async (panelData) => {
        if (!imageFiles) return;
        const mdPath = pathToMdPath(panelData.path);
        const mdFile = dc.app.vault.getAbstractFileByPath(mdPath);
        let tags = [];
        if (mdFile) {
            const cache = dc.app.metadataCache.getFileCache(mdFile);
            const fm = cache?.frontmatter;
            if (fm) {
                const tagSet = new Set();
                ['tags', 'A888a', 'data-aaa-tags'].forEach(key => {
                    const val = fm[key];
                    if (val) { (Array.isArray(val) ? val : String(val).split(/, ?/)).forEach(tag => { if (typeof tag === 'string' && tag.trim()) tagSet.add(tag.trim()); }); }
                });
                tags = Array.from(tagSet);
            }
        }
        setPanel({ ...panelData, tags });
    }, [imageFiles]);

    const handleViewChange = useCallback((newView) => {
        if (viewType === 'graph' && newView === 'grid' && graphNodesRef.current) {
            const positions = new Map(
                graphNodesRef.current.map(node => [node.file.path, { x: node.x, y: node.y }])
            );
            setTransitionInitialPositions(positions);
            setIsTransitioning(true);
        } else {
            setTransitionInitialPositions(null);
        }
        setViewType(newView);
    }, [viewType]);

    const handleTransitionEnd = useCallback(() => {
        setIsTransitioning(false);
        setTransitionInitialPositions(null);
    }, []);

    const handleTagSearch = useCallback((tag) => {
        if (searchTerm === tag) { setSearchTerm(''); }
        else { setSearchTerm(tag); }
    }, [searchTerm]);

    const handleToggleFullscreen = useCallback(() => {
        setIsFullscreen(prev => !prev);
    }, []);

    const handleToggleSelection = useCallback((path) => { const newSelection = new Set(selectedPaths); if (newSelection.has(path)) { newSelection.delete(path); } else { newSelection.add(path); } setSelectedPaths(newSelection); }, [selectedPaths]);
    const handleToggleSelectionMode = () => { if (isSelectionMode) { setSelectedPaths(new Set()); } setIsSelectionMode(!isSelectionMode); };
    useEffect(() => { const handleKeydown = (e) => { if (e.key === "Escape") { if (panel) { setPanel(null); } else if (selectedPaths.size > 0) { setSelectedPaths(new Set()); } else if (isSelectionMode) { setIsSelectionMode(false); } else if (searchTerm) { setSearchTerm(''); } } }; window.addEventListener("keydown", handleKeydown); return () => window.removeEventListener("keydown", handleKeydown); }, [panel, searchTerm, isSelectionMode, selectedPaths]);
    useEffect(() => { const handleSearchShortcut = (e) => { if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); searchInputRef.current?.focus(); } }; window.addEventListener('keydown', handleSearchShortcut); return () => window.removeEventListener('keydown', handleSearchShortcut); }, []);

    useEffect(() => {
        if (!hasConsented) return;
        Core.loadRemovedImagePaths().then(setRemovedImages);
    }, [hasConsented]);

    const ensureMarkdownTwin = async (svgPath) => {
        const mdPath = pathToMdPath(svgPath);
        let mdFile = dc.app.vault.getAbstractFileByPath(mdPath);
        if (!mdFile || mdFile.extension !== 'md') {
            try { await dc.app.vault.create(mdPath, `---\n---\n`); mdFile = dc.app.vault.getAbstractFileByPath(mdPath); }
            catch (e) { console.error(`Failed to create ${mdPath}:`, e); return null; }
        }
        return mdFile;
    };
    const modifyFrontmatter = async (paths, modificationFn) => {
        let successCount = 0;
        try {
            for (const svgPath of paths) {
                const mdFile = await ensureMarkdownTwin(svgPath);
                if (!mdFile) continue;
                await dc.app.fileManager.processFrontMatter(mdFile, modificationFn);
                successCount++;
            }
        } catch (err) { console.error("Error during mass frontmatter edit:", err); }
        setSelectedPaths(new Set()); setIsSelectionMode(false); setFileListVersion(v => v + 1);
    };
    const handleApplyListPreset = async (listKey, presetValue) => { modifyFrontmatter(selectedPaths, (fm) => { fm[listKey] = fm[listKey] || []; if (!Array.isArray(fm[listKey])) { fm[listKey] = [fm[listKey]]; } const set = new Set(fm[listKey]); set.add(presetValue); fm[listKey] = Array.from(set); }); };
    const handleApplyPreset = async (presetValue) => { await handleApplyListPreset('data-aaa-tags', presetValue); };
    const handleApplyA888a = async (presetValue) => { await handleApplyListPreset('A888a', presetValue); };
    const handleApplyCustom = async (key, value) => { if (!key.trim()) return; modifyFrontmatter(selectedPaths, (fm) => { fm[key.trim()] = value.trim(); }); };
    
    const handleQuickAddTag = async (tagValue) => {
        if (!tagValue.trim()) return;
        await modifyFrontmatter(selectedPaths, (fm) => {
            let tags = fm.tags || fm.tag || [];
            if (!Array.isArray(tags)) {
                tags = [tags];
            }
            const cleanTag = tagValue.trim();
            if (!tags.includes(cleanTag)) {
                tags.push(cleanTag);
            }
            fm.tags = tags;
            if (fm.tag) delete fm.tag;
        });
    };
    
    const handleDeleteSelected = async () => {
        const count = selectedPaths.size;
        if (!confirm(`Are you sure you want to delete the ${count} selected asset(s)? This will permanently delete both the SVG drawings and their source Markdown twin files.`)) {
            return;
        }
        
        let deletedCount = 0;
        const pathsToRemove = new Set(selectedPaths);
        
        // Immediate local state update to make UI snappy
        setImageFiles(prev => {
            if (!prev) return prev;
            return prev.filter(file => !pathsToRemove.has(file.path));
        });
        setSelectedPaths(new Set());
        setIsSelectionMode(false);

        for (const svgPath of pathsToRemove) {
            let svgDeleted = false;
            // 1. Delete SVG file
            try {
                const svgFile = dc.app.vault.getAbstractFileByPath(svgPath);
                if (svgFile) {
                    await dc.app.vault.delete(svgFile);
                    svgDeleted = true;
                } else {
                    svgDeleted = true; // Count as deleted since it doesn't exist
                }
            } catch (e) {
                // If it's already gone from disk, we count it as deleted
                if (e.message && (e.message.includes('ENOENT') || e.message.includes('no such file'))) {
                    svgDeleted = true;
                } else {
                    console.error(`Failed to delete SVG asset ${svgPath}:`, e);
                }
            }

            // 2. Delete MD file
            try {
                const mdPath = svgPath.replace(/\.svg$/i, '.md');
                const mdFile = dc.app.vault.getAbstractFileByPath(mdPath);
                if (mdFile) {
                    await dc.app.vault.delete(mdFile);
                }
            } catch (e) {
                if (e.message && !e.message.includes('ENOENT') && !e.message.includes('no such file')) {
                    console.error(`Failed to delete MD twin file for ${svgPath}:`, e);
                }
            }

            // 3. Delete excalidraw.md file
            try {
                const excalidrawMdPath = svgPath.replace(/\.excalidraw\.svg$/i, '.excalidraw.md');
                const excalidrawMdFile = dc.app.vault.getAbstractFileByPath(excalidrawMdPath);
                if (excalidrawMdFile) {
                    await dc.app.vault.delete(excalidrawMdFile);
                }
            } catch (e) {
                if (e.message && !e.message.includes('ENOENT') && !e.message.includes('no such file')) {
                    console.error(`Failed to delete excalidraw.md twin file for ${svgPath}:`, e);
                }
            }

            if (svgDeleted) {
                deletedCount++;
            }
        }

        console.log(`[ASSETS LIBRARY] Deleted ${deletedCount} assets from vault.`);
        
        // Wait a short moment for Obsidian to process filesystem events, then trigger reload
        await new Promise(resolve => setTimeout(resolve, 300));
        setFileListVersion(v => v + 1);
    };

    const handleHideSelected = () => {
        const e = new Set(removedImages);
        for (const svgPath of selectedPaths) {
            e.add(svgPath);
        }
        setRemovedImages(e);
        Core.saveRemovedImagePaths(e);
        setSelectedPaths(new Set());
        setIsSelectionMode(false);
    };
    
    const handleToggleHide = () => { 
        if (!panel?.path) return; 
        const e = new Set(removedImages); 
        e.has(panel.path) ? e.delete(panel.path) : e.add(panel.path); 
        setRemovedImages(e); 
        Core.saveRemovedImagePaths(e); 
    };
    const restoreAllHidden = async () => { 
        const e = new Set(); 
        setRemovedImages(e); 
        await Core.saveRemovedImagePaths(e); 
    };
    const handleRetryConversion = async () => {
        if (!panel?.path || !converterDeps) return;
        
        // Get the .md file path from the .svg path
        const mdPath = panel.path.replace(/\.svg$/i, '.md');
        
        try {
            // Check if .md file exists
            const mdFile = dc.app.vault.getAbstractFileByPath(mdPath);
            if (!mdFile) {
                console.error('Source .md file not found:', mdPath);
                return;
            }
            
            // Clear the old image from cache before conversion
            Core.globalImageCache.delete(panel.path);
            
            // Run conversion
            console.log('Retrying conversion for:', mdPath);
            const result = await Core.Converter.processFileWithLibrary(
                mdPath,
                converterDeps.ExcalidrawModule,
                converterDeps.LZString,
                converterDeps.fontData,
                (msg) => console.log('[Retry Conversion]', msg)
            );
            
            if (result.success) {
                console.log('✅ Conversion successful');
                
                // Wait a moment for file system to update
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Clear cache again to ensure fresh load
                Core.globalImageCache.delete(panel.path);
                
                // Refresh file list to show updated SVG
                setFileListVersion(v => v + 1);
                
                // Trigger cache update to re-render canvas
                if (onCacheUpdateRef.current) {
                    onCacheUpdateRef.current();
                }
                
                // Update the panel with fresh image data
                const svgFile = dc.app.vault.getAbstractFileByPath(panel.path);
                if (svgFile) {
                    // Force reload the image by creating a new panel object
                    setPanel(prev => prev ? { ...prev, path: prev.path } : null);
                }
            } else {
                console.error('Conversion failed');
            }
        } catch (err) {
            console.error('Error during retry conversion:', err);
        }
    };
    const handleCopyMarkdown = () => { 
        if (!panel?.path) return; 
        const e = panel.path.split("/").pop().replace(".svg", ""); 
        navigator.clipboard.writeText(`![[${e}]]`); 
    };
    const handleCopySvgContent = async () => { 
        if (!panel?.path || !imageFiles) return; 
        const e = imageFiles.find(e => e.path === panel.path); 
        if (!e) return; 
        const t = await dc.app.vault.read(e); 
        navigator.clipboard.writeText(t); 
    };
    const handleCopyFile = async () => { 
        if (!panel?.path || !imageFiles) return; 
        try { 
            const e = imageFiles.find(e => e.path === panel.path); 
            if (!e) throw new Error("File not found"); 
            const t = await dc.app.vault.read(e);
            const r = (new DOMParser).parseFromString(t, "image/svg+xml");
            const s = r.documentElement; 
            if (s.tagName.toLowerCase().includes("parsererror")) throw new Error("Failed to parse SVG."); 
            if (!s.getAttribute("width") || !s.getAttribute("height")) { 
                const e = s.getAttribute("viewBox"); 
                if (e) { 
                    const t = e.trim().split(/\s+/); 
                    if (t.length === 4) {
                        if (!s.getAttribute("width")) s.setAttribute("width", t[2]);
                        if (!s.getAttribute("height")) s.setAttribute("height", t[3]);
                    }
                } 
            } 
            const a = (new XMLSerializer).serializeToString(r);
            const o = new Blob([a], { type: "image/svg+xml" }); 
            await navigator.clipboard.write([new ClipboardItem({ "image/svg+xml": o })]); 
        } catch (e) { 
            console.error("Failed to copy file:", e); 
        } 
    };

    // While checking for consent, render a blank screen to avoid flicker
    if (hasConsented === null) {
        return <div style={{ height: '100%', width: '100%', background: 'var(--background-primary)' }}></div>;
    }

    // If consent checking is in progress, show loading state
    if (hasConsented === null) {
        return (<div style={{ padding: '16px', textAlign: 'center' }}><p>Checking settings...</p></div>);
    }

    if (converterStatus === 'loading') {
        return <ConverterLoadingView logs={converterLogs} syncStatus="idle" syncProgress={{ processed: 0, converted: 0, total: 0, skipped: 0 }} syncLogs={[]} />;
    }
    if (converterStatus === 'error') {
        return <ConverterErrorView error={converterError} />;
    }

    if (imageFiles === null) {
        return (<div style={{ padding: '16px', textAlign: 'center' }}><p>Scanning for images...</p></div>);
    }

    if (workerError) { return (<div style={{ padding: '16px', textAlign: 'center' }}><p style={{ color: '#ff8a8a' }}>Worker Failed</p><p style={{ color: '#aaa', fontSize: '12px' }}>{workerError}</p></div>) }

    if (imageFiles.length === 0 && potentialMdFileCount === 0 && syncStatus !== 'syncing') {
        return (
            <div ref={containerRef} style={{ height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--background-primary)', color: 'var(--text-normal)', fontFamily: 'monospace' }}>
                <style>{`${viewStyling}`}</style>
                <div style={{ padding: '30px', textAlign: 'center', background: 'var(--background-secondary)', borderRadius: '16px', border: '1px solid var(--background-modifier-border)', boxShadow: '0 24px 80px rgba(0, 0, 0, 0.15)', maxWidth: '400px', width: '90%' }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" style={{ marginBottom: '16px' }}>
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <h3 style={{ margin: '0 0 10px 0', fontSize: '16px', fontWeight: 'bold', color: 'var(--text-normal)' }}>No Folders Configured</h3>
                    <p style={{ margin: '0 0 24px 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                        Choose what folder you want to load assets from to get started.
                    </p>
                    <button onClick={() => setIsSettingsOpen(true)} style={{ width: '100%', padding: '10px 14px', background: 'var(--interactive-accent)', border: 'none', borderRadius: '6px', color: 'var(--text-on-accent, #fff)', cursor: 'pointer', fontWeight: 'bold' }}>
                        Select Folder
                    </button>
                </div>
                {isSettingsOpen && (
                    <SettingsModal 
                        config={config} 
                        folderPath={folderPath}
                        onSave={async (newConfig, triggerSync = false) => {
                            console.log("[ASSETS LIBRARY] onSave (Initial setup screen): saving newConfig:", newConfig, "triggerSync:", triggerSync);
                            setConfig(newConfig);
                            const dir = CONSENT_FILE_PATH.substring(0, CONSENT_FILE_PATH.lastIndexOf("/"));
                            if (!(await dc.app.vault.adapter.exists(dir))) {
                                console.log("[ASSETS LIBRARY] Creating consent directory:", dir);
                                await ensureDirRecursive(dir);
                            }
                            await dc.app.vault.adapter.write(CONSENT_FILE_PATH, JSON.stringify({ consented: true, ...newConfig }, null, 2));
                            
                            const localDirs = (newConfig.localPath || "").split(/[,,;]/).map(p => p.trim()).filter(Boolean);
                            console.log("[ASSETS LIBRARY] Target local folders to verify/create:", localDirs);
                            for (const localDir of localDirs) {
                                if (!(await dc.app.vault.adapter.exists(localDir))) {
                                    console.log("[ASSETS LIBRARY] Creating local directory:", localDir);
                                    await ensureDirRecursive(localDir);
                                }
                                const gitignorePath = `${localDir}/.gitignore`;
                                if (!(await dc.app.vault.adapter.exists(gitignorePath))) {
                                    console.log("[ASSETS LIBRARY] Writing .gitignore to:", gitignorePath);
                                    await dc.app.vault.adapter.write(gitignorePath, "*\n!.gitignore\n");
                                }
                            }
                            
                            setFileListVersion(v => v + 1);
                            setIsSettingsOpen(false);
                            if (triggerSync) {
                                setTimeout(() => {
                                    syncFromGitHub(false, newConfig);
                                }, 300);
                            }
                        }}
                        onClose={() => setIsSettingsOpen(false)}
                    />
                )}
            </div>
        );
    }

    if (visibleImageFiles.length === 0 && imageFiles.length > 0 && isFullscreen) { return (<div style={{ padding: '16px', textAlign: 'center' }}><p>All images hidden.</p><button className="btn" onClick={restoreAllHidden}>Restore All</button></div>) }

    const viewProps = {
        isFullTab: isFullscreen, onCardClick, imagesToDisplay: sortedAndVisibleImageFiles,
        a888aTagsMap: imageTagsMap,
        isSearching, matchingImagePaths, isSelectionMode, selectedPaths, onToggleSelection: handleToggleSelection,
        imageCache, requestImages, requestedSet, onCacheUpdate: onCacheUpdateRef, interactingUntilRef,
        resetViewKey, isLightMode: isLightMode && !config?.disableColorInvert
    };

    return (
        <div ref={containerRef} className={`assets-library-container ${config?.disableColorInvert ? 'disable-color-invert' : ''}`} style={{ height: '100%', width: '100%', position: 'relative' }}>
            <style>{`${viewStyling}`}</style>
            
            {/* Background Notifications - stacked vertically */}
            {showSyncNotification && (
                <BackgroundSyncNotification 
                    syncStatus={syncStatus} 
                    syncProgress={syncProgress}
                    onDismiss={() => setShowSyncNotification(false)}
                    onCancel={cancelSync}
                    notificationIndex={0}
                />
            )}
            
            {showConversionNotification && (
                <BackgroundConversionNotification 
                    isConverting={isConverting} 
                    conversionProgress={conversionProgress}
                    onDismiss={() => setShowConversionNotification(false)}
                    notificationIndex={showSyncNotification && syncStatus === 'syncing' ? 1 : 0}
                />
            )}
            
            <div className="full-tab-wrapper">
                
                {viewType === 'grid' && <GridView {...viewProps} isTransitioning={isTransitioning} initialPositions={transitionInitialPositions} onTransitionEnd={handleTransitionEnd} />}
                {viewType === 'graph' && <GraphView {...viewProps} nodesRef={graphNodesRef} />}

                <div className="overlay">
                    <SearchBar
                        onInputMount={(node) => searchInputRef.current = node}
                        searchTerm={searchTerm}
                        onSearchChange={setSearchTerm}
                        onClear={() => setSearchTerm('')}
                        sortOption={sortOption}
                        onSortChange={setSortOption}
                        sortOptions={sortOptions}
                        viewType={viewType}
                        onViewChange={handleViewChange}
                        isSelectionMode={isSelectionMode}
                        onToggleSelectionMode={handleToggleSelectionMode}
                        allTags={allUniqueTags}
                        onTagClick={handleTagSearch}
                        onResetView={() => setResetViewKey(k => k + 1)}
                        onSyncGitHub={syncFromGitHub}
                        syncStatus={syncStatus}
                        onOpenSettings={() => setIsSettingsOpen(true)}
                    />
                    {isSearching && matchingImagePaths.size === 0 && (<div className="search-no-results">No results for "{searchTerm}"</div>)}
                    {isSelectionMode && selectedPaths.size > 0 && (
                        <MassEditPanel 
                            selectedCount={selectedPaths.size} 
                            onApplyPreset={handleApplyPreset} 
                            onApplyA888a={handleApplyA888a} 
                            onApplyCustom={handleApplyCustom} 
                            onQuickAddTag={handleQuickAddTag}
                            onDeleteSelected={handleDeleteSelected}
                            onHide={handleHideSelected}
                            onClear={() => setSelectedPaths(new Set())} 
                            onClose={handleToggleSelectionMode} 
                        />
                    )}
                    {panel && (
                        <div className="panel-wrap" onClick={(e) => { if (e.target === e.currentTarget) setPanel(null); }}>
                            <div className="panel">
                                <div className="panel-img-box"><ZoomableImage lowResUrl={panel.lowResUrl} initialBitmap={panel.initialBitmap} highResPath={panel.path} alt={panel.path} /></div>
                                <div className="panel-controls">
                                    <div className="panel-info">
                                        <div className="panel-title">{panel.path.split('/').pop().replace('.svg', '')}</div>
                                        <div className="panel-row">Path: {panel.path}</div>
                                        {panel.tags && panel.tags.length > 0 && (<div className="panel-tags">{panel.tags.map(tag => <span key={tag} className="panel-tag">{tag}</span>)}</div>)}
                                    </div>
                                    <div className="btn-group">
                                        <button className="panel-icon-btn" onClick={handleCopyMarkdown} title="Copy Markdown Link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"></path></svg></button>
                                        <button className="panel-icon-btn" onClick={handleCopySvgContent} title="Copy SVG Content"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg></button>
                                        <button className="panel-icon-btn" onClick={handleCopyFile} title="Copy File"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                                        <button className="panel-icon-btn" onClick={handleRetryConversion} title="Retry Conversion"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" /></svg></button>
                                        {removedImages.has(panel.path) ? (<button className="panel-icon-btn active" onClick={handleToggleHide} title="Unhide Image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></button>) : (<button className="panel-icon-btn danger" onClick={handleToggleHide} title="Hide Image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></button>)}
                                        <button className="panel-icon-btn" onClick={() => setPanel(null)} title="Close Panel (Esc)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            
            {/* Settings & Folder Configurations Popup Dialog Overlay */}
            {isSettingsOpen && (
                <SettingsModal 
                    config={config} 
                    folderPath={folderPath}
                    onSave={async (newConfig, triggerSync = false) => {
                        console.log("[ASSETS LIBRARY] onSave (Settings menu): saving newConfig:", newConfig, "triggerSync:", triggerSync);
                        
                        // Identify removed repositories to delete their folders from filesystem
                        const oldRepos = config.repos || [];
                        const newRepos = newConfig.repos || [];
                        const removed = oldRepos.filter(oldRepo => 
                            !newRepos.some(newRepo => 
                                newRepo.repoOwner.toLowerCase() === oldRepo.repoOwner.toLowerCase() &&
                                newRepo.repoName.toLowerCase() === oldRepo.repoName.toLowerCase()
                            )
                        );
                        
                        const firstFolder = (newConfig.localPath || "").split(/[,,;]/)[0]?.trim() || (folderPath ? `${folderPath.replace(/\/[^\/]+\.md$/, '')}/assets` : FOLDER_PATH);
                        for (const repo of removed) {
                            try {
                                const repoFolderPath = `${firstFolder}/${repo.repoName}`;
                                const folder = dc.app.vault.getAbstractFileByPath(repoFolderPath);
                                if (folder) {
                                    console.log("[ASSETS LIBRARY] Deleting folder for removed repository:", repoFolderPath);
                                    await dc.app.vault.delete(folder, true);
                                }
                            } catch (e) {
                                console.error("[ASSETS LIBRARY] Failed to delete folder for removed repository:", repo.repoName, e);
                            }
                        }

                        setConfig(newConfig);
                        const dir = CONSENT_FILE_PATH.substring(0, CONSENT_FILE_PATH.lastIndexOf("/"));
                        if (!(await dc.app.vault.adapter.exists(dir))) {
                            console.log("[ASSETS LIBRARY] Creating consent directory:", dir);
                            await ensureDirRecursive(dir);
                        }
                        await dc.app.vault.adapter.write(CONSENT_FILE_PATH, JSON.stringify({ consented: true, ...newConfig }, null, 2));
                        
                        // Ensure all local target folders exist in the vault
                        const localDirs = (newConfig.localPath || "").split(/[,,;]/).map(p => p.trim()).filter(Boolean);
                        console.log("[ASSETS LIBRARY] Target local folders to verify/create:", localDirs);
                        for (const localDir of localDirs) {
                            if (!(await dc.app.vault.adapter.exists(localDir))) {
                                console.log("[ASSETS LIBRARY] Creating local directory:", localDir);
                                await ensureDirRecursive(localDir);
                            }
                            const gitignorePath = `${localDir}/.gitignore`;
                            if (!(await dc.app.vault.adapter.exists(gitignorePath))) {
                                console.log("[ASSETS LIBRARY] Writing .gitignore to:", gitignorePath);
                                await dc.app.vault.adapter.write(gitignorePath, "*\n!.gitignore\n");
                            }
                        }
                        
                        setFileListVersion(v => v + 1);
                        setIsSettingsOpen(false);
                        if (triggerSync) {
                            setTimeout(() => {
                                syncFromGitHub(false, newConfig);
                            }, 300);
                        }
                    }}
                    onClose={() => setIsSettingsOpen(false)}
                />
            )}
        </div>
    );
};

return { AssetsLibrary };
