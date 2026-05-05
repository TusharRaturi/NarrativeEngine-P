import { useEffect, useRef, useState } from 'react';
import { Application, Graphics, Container, Assets, Sprite, Texture, Rectangle, Text } from 'pixi.js';
import * as filters from 'pixi-filters';

// Tile Coordinates for PicoVillage (16x16 units)
const PICO_TILES = {
    OUTDOOR: '/assets/tilesets/picovillage/OutDoorTiles.png',
    WATER: '/assets/tilesets/picovillage/WaterTileSet.png',
    ROCKS: '/assets/tilesets/picovillage/LoftedRocks.png'
};

const FANTASY_TILES = {
    GROUND: '/assets/tilesets/The Fan-tasy Tileset (Free)/Art/Ground Tileset/Tileset_Ground.png',
    WATER: '/assets/tilesets/The Fan-tasy Tileset (Free)/Art/Water and Sand/Tileset_Water.png'
};

const SNOW_TILES = {
    BASE: '/assets/Snow Asset Pack/Terrain/Snow/Snow_1.png',
    VARIANTS: [
        '/assets/Snow Asset Pack/Terrain/Snow/Snow_0.png',
        '/assets/Snow Asset Pack/Terrain/Snow/Snow_1.png',
        '/assets/Snow Asset Pack/Terrain/Snow/Snow_2.png',
        '/assets/Snow Asset Pack/Terrain/Snow/Snow_3.png',
        '/assets/Snow Asset Pack/Terrain/Snow/Snow_4.png',
        '/assets/Snow Asset Pack/Terrain/Snow/Snow_5.png',
    ],
    CLIFF: '/assets/Snow Asset Pack/Terrain/Snow/Cliff_Top.png',
    TREE: '/assets/Snow Asset Pack/Trees/Tree_1.png'
};

const DESERT_TILES = {
    BASE: '/assets/tilesets/Desert/sand.png',
    CACTUS: '/assets/tilesets/Desert/decor_cactus1.png',
    PALM: '/assets/tilesets/Desert/tree_palm1.png'
};

// Source Rectangles (x, y, w, h in 16px units)
const TILE_MAP = {
    GRASS: { x: 0, y: 0 },
    GRASS_TUFTS: { x: 1, y: 0 },
    GRASS_FLOWERS: { x: 3, y: 0 },
    DIRT: { x: 0, y: 8 }, 
    SAND: { x: 0, y: 16 },
    WATER: { x: 0, y: 0 }, // From WaterTileSet
    ROCK_PEAK: { x: 1, y: 0 } // From LoftedRocks
};
import { useAppStore } from '../../store/useAppStore';
import { REGISTRIES } from '../../services/mapEngine/registries';

const DRAG_THRESHOLD = 5;


function getAllBiomes(): { id: string; color: string }[] {
    const merged: { id: string; color: string }[] = [];
    const seen = new Set<string>();
    for (const reg of Object.values(REGISTRIES)) {
        for (const b of reg) {
            if (!seen.has(b.id)) {
                seen.add(b.id);
                merged.push({ id: b.id, color: b.color });
            }
        }
    }
    return merged;
}



function getTileType(biomeId: string) {
    const b = biomeId.toLowerCase();
    if (b.includes('snow') || b.includes('arctic') || b.includes('ice') || b.includes('tundra')) return 'snow';
    if (b.includes('water') || b.includes('ocean')) return 'water';
    if (b.includes('desert') || b.includes('dune') || b.includes('sand')) return 'desert';
    if (b.includes('dirt') || b.includes('path')) return 'dirt';
    return 'grass';
}

function getPropKey(biomeId: string) {
    const b = biomeId.toLowerCase();
    if (b.includes('snow') || b.includes('arctic')) return 'snow_tree';
    if (b.includes('desert') || b.includes('dune')) return 'desert_prop';
    if (b.includes('forest') || b.includes('wood')) return 'forest';
    if (b.includes('mountain') || b.includes('peak')) return 'mountain';
    return null;
}

export function OverworldCanvas() {
    const containerRef = useRef<HTMLDivElement>(null);
    const appRef = useRef<Application | null>(null);
    const worldRef = useRef<Container | null>(null);
    const playerRef = useRef<Graphics | null>(null);
    const cellSizeRef = useRef(10);
    const mapDimsRef = useRef({ w: 0, h: 0 });
    const isPanning = useRef(false);
    const panStart = useRef({ x: 0, y: 0 });
    const containerStart = useRef({ x: 0, y: 0 });
    const deadRef = useRef(false);
    const texturesRef = useRef<Record<string, Texture>>({});
    const propsRef = useRef<Record<string, Texture>>({});
    const displacementRef = useRef<Sprite | null>(null);
    const pinContainerRef = useRef<Container | null>(null);
    const isPinModeRef = useRef(false);
    const [pixiReady, setPixiReady] = useState(false);
    const [pinLabelDraft, setPinLabelDraft] = useState('');

    const overworldMap = useAppStore(s => s.overworldMap);
    const playerPosition = useAppStore(s => s.playerPosition);
    const setPlayerPosition = useAppStore(s => s.setPlayerPosition);
    const isPinMode = useAppStore(s => s.isPinMode);
    const pendingPin = useAppStore(s => s.pendingPin);
    const setPendingPin = useAppStore(s => s.setPendingPin);
    const addPin = useAppStore(s => s.addPin);
    const pins = useAppStore(s => s.overworldMap?.pins ?? []);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);

    useEffect(() => { isPinModeRef.current = isPinMode; }, [isPinMode]);
    useEffect(() => { if (pendingPin === null) setPinLabelDraft(''); }, [pendingPin]);

    useEffect(() => {
        if (!containerRef.current) return;
        deadRef.current = false;

        const app = new Application();
        appRef.current = app;

        const init = async () => {
            await app.init({
                resizeTo: containerRef.current!,
                background: '#111118',
                antialias: false,
                roundPixels: true,
            });

            if (deadRef.current) return;

            containerRef.current!.appendChild(app.canvas as HTMLCanvasElement);

            const world = new Container();
            world.sortableChildren = true;
            app.stage.addChild(world);
            worldRef.current = world;

            const player = new Graphics();
            player.zIndex = 10;
            world.addChild(player);
            playerRef.current = player;

            app.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
                isPanning.current = false;
                panStart.current = { x: e.clientX, y: e.clientY };
                containerStart.current = { x: world.x, y: world.y };
            });

            app.canvas.addEventListener('pointermove', (e: PointerEvent) => {
                if (e.buttons === 0) return;
                const dx = e.clientX - panStart.current.x;
                const dy = e.clientY - panStart.current.y;
                if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
                    isPanning.current = true;
                }
                if (isPanning.current) {
                    world.x = containerStart.current.x + dx;
                    world.y = containerStart.current.y + dy;
                }
            });

            app.canvas.addEventListener('pointerup', (e: PointerEvent) => {
                if (isPanning.current) return;
                const { w, h } = mapDimsRef.current;
                if (w === 0 || h === 0) return;

                const rect = app.canvas.getBoundingClientRect();
                const localX = (e.clientX - rect.left - world.x) / world.scale.x;
                const localY = (e.clientY - rect.top - world.y) / world.scale.y;
                const cs = cellSizeRef.current;
                const gridCol = Math.floor(localX / cs);
                const gridRow = Math.floor(localY / cs);

                if (gridCol < 0 || gridCol >= w || gridRow < 0 || gridRow >= h) return;

                if (isPinModeRef.current) {
                    setPendingPin({ x: gridCol, y: gridRow });
                } else {
                    setPlayerPosition({ x: gridCol, y: gridRow });
                }
            });

            app.canvas.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                if (isPinModeRef.current) return;
                const rect = app.canvas.getBoundingClientRect();
                const localX = (e.clientX - rect.left - world.x) / world.scale.x;
                const localY = (e.clientY - rect.top - world.y) / world.scale.y;
                const cs = cellSizeRef.current;
                const gridCol = Math.floor(localX / cs);
                const gridRow = Math.floor(localY / cs);
                const store = useAppStore.getState();
                const currentPins = store.overworldMap?.pins ?? [];
                const hit = currentPins.find(p => Math.abs(p.x - gridCol) <= 1 && Math.abs(p.y - gridRow) <= 1);
                if (hit) {
                    const cid = store.activeCampaignId;
                    if (cid) store.deletePin(cid, hit.id);
                }
            });

            app.canvas.addEventListener('wheel', (e: WheelEvent) => {
                e.preventDefault();
                const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
                const newScale = Math.max(0.3, Math.min(5, world.scale.x * zoomFactor));
                const rect = app.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const wx = (mouseX - world.x) / world.scale.x;
                const wy = (mouseY - world.y) / world.scale.y;
                world.scale.set(newScale);
                world.x = mouseX - wx * newScale;
                world.y = mouseY - wy * newScale;
            }, { passive: false });

            try {
                // Load PicoVillage sheets
                const outdoorBase = await Assets.load({ src: PICO_TILES.OUTDOOR, data: { scaleMode: 'nearest' } });
                await Assets.load({ src: PICO_TILES.WATER, data: { scaleMode: 'nearest' } });
                const rockBase = await Assets.load({ src: PICO_TILES.ROCKS, data: { scaleMode: 'nearest' } });
                
                // Load Expansion Packs
                const fantasyGround = await Assets.load({ src: FANTASY_TILES.GROUND, data: { scaleMode: 'nearest' } });
                const fantasyWater = await Assets.load({ src: FANTASY_TILES.WATER, data: { scaleMode: 'nearest' } });
                
                // Load Snow Variants
                const snowVariants = await Promise.all(SNOW_TILES.VARIANTS.map(src => 
                    Assets.load({ src, data: { scaleMode: 'nearest' } })
                ));

                const snowCliff = await Assets.load({ src: SNOW_TILES.CLIFF, data: { scaleMode: 'nearest' } });
                const snowTree = await Assets.load({ src: SNOW_TILES.TREE, data: { scaleMode: 'nearest' } });
                const desertBase = await Assets.load({ src: DESERT_TILES.BASE, data: { scaleMode: 'nearest' } });
                const cactus = await Assets.load({ src: DESERT_TILES.CACTUS, data: { scaleMode: 'nearest' } });
                const palm = await Assets.load({ src: DESERT_TILES.PALM, data: { scaleMode: 'nearest' } });

                const getTile = (base: any, tx: number, ty: number) => {
                    return new Texture({
                        source: base.source,
                        frame: new Rectangle(tx * 16, ty * 16, 16, 16)
                    });
                };

                texturesRef.current = {
                    water: getTile(fantasyWater, 1, 1),
                    dirt: getTile(outdoorBase, TILE_MAP.DIRT.x, TILE_MAP.DIRT.y),
                    sand: getTile(outdoorBase, TILE_MAP.SAND.x, TILE_MAP.SAND.y),
                    mountain: getTile(rockBase, TILE_MAP.ROCK_PEAK.x, TILE_MAP.ROCK_PEAK.y),
                    snow: snowVariants[1], // Default base
                    snow_mountain: snowCliff,
                    desert: desertBase
                };

                // Store individual snow variants
                snowVariants.forEach((tex, i) => {
                    texturesRef.current[`snow_${i}`] = tex;
                });

                // Load 12 seamless grass variants from user-selected solid vibrancy set
                // Top-left origin: x = 1 to 6, y = 9 to 10
                let grassVariantCount = 0;
                for (let yy = 9; yy <= 10; yy++) {
                    for (let xx = 1; xx <= 6; xx++) {
                        texturesRef.current[`grass_${grassVariantCount}`] = getTile(fantasyGround, xx, yy);
                        grassVariantCount++;
                    }
                }
                
                // Fallback 'grass' key and Solid Base (1,9) to plug any potential gaps
                texturesRef.current['grass'] = texturesRef.current['grass_0'];
                texturesRef.current['grass_solid'] = getTile(fantasyGround, 1, 9);

                propsRef.current = {
                    snow_tree: snowTree,
                    cactus: cactus,
                    palm: palm
                };

                // Add edge tiles for auto-tiling
                texturesRef.current['edge_n'] = getTile(outdoorBase, 1, 16);
                texturesRef.current['edge_s'] = getTile(outdoorBase, 1, 18);
                texturesRef.current['edge_e'] = getTile(outdoorBase, 2, 17);
                texturesRef.current['edge_w'] = getTile(outdoorBase, 0, 17);
                // Corners
                texturesRef.current['edge_ne'] = getTile(outdoorBase, 2, 16);
                texturesRef.current['edge_nw'] = getTile(outdoorBase, 0, 16);
                texturesRef.current['edge_se'] = getTile(outdoorBase, 2, 18);
                texturesRef.current['edge_sw'] = getTile(outdoorBase, 0, 18);

                const dmTex = await Assets.load('/assets/textures/displacement_map.png');
                const dmSprite = new Sprite(dmTex);
                dmSprite.texture.baseTexture.wrapMode = 'repeat';
                displacementRef.current = dmSprite;

            } catch (err) {
                console.error("Failed to load map assets:", err);
            }

            if (deadRef.current) return;
            setPixiReady(true);
        };

        init();

        return () => {
            deadRef.current = true;
            setPixiReady(false);
            if (appRef.current) {
                try { appRef.current.destroy(true); } catch {}
            }
            appRef.current = null;
            worldRef.current = null;
            playerRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!pixiReady || !worldRef.current || !overworldMap) return;

        const world = worldRef.current;
        const allBiomes = getAllBiomes();
        const colorMap: Record<string, string> = {};
        for (const b of allBiomes) colorMap[b.id] = b.color;

        const { width, height, cells } = overworldMap;

        if (!cells || cells.length === 0) return;

        const canvasW = containerRef.current?.clientWidth || 600;
        const canvasH = containerRef.current?.clientHeight || 600;
        const cellSize = Math.max(1, Math.floor(Math.min(canvasW / width, canvasH / height)));
        cellSizeRef.current = cellSize;
        mapDimsRef.current = { w: width, h: height };

        while (world.children.length > 0) {
            const child = world.children[0];
            if (child === playerRef.current) break;
            world.removeChildAt(0);
            child.destroy();
        }

        const waterContainer = new Container();
        const landContainer = new Container();
        const propContainer = new Container();
        const anchorContainer = new Container();
        
        const grid = new Container();
        grid.addChild(waterContainer, landContainer, propContainer, anchorContainer);
        grid.zIndex = 0;
        
        // Setup Displacement for Water Ripple (DISABLED per request for static shimmer)
        /*
        if (displacementRef.current) {
            const dm = displacementRef.current;
            const filter = new DisplacementFilter(dm);
            filter.scale.set(4); 
            waterContainer.filters = [filter];
            world.addChild(dm);
            dm.visible = false;
            
            appRef.current?.ticker.add((ticker) => {
                dm.x += 0.05 * ticker.deltaTime;
                dm.y += 0.02 * ticker.deltaTime;
            });
        }
        */

        const getCell = (c: number, r: number) => {
            if (c < 0 || c >= width || r < 0 || r >= height) return null;
            return cells[r * width + c] as { biome: string; isOcean: boolean };
        };

        for (let i = 0; i < cells.length; i++) {
            const col = i % width;
            const row = Math.floor(i / width);
            const cell = cells[i] as { biome: string; isOcean: boolean; anchorName?: string | null };
            
            const x = col * cellSize;
            const y = row * cellSize;

            // 1. Draw Base Tile with Variety
            let tileType = getTileType(cell.biome);
            
            // Experimental Ice for far north
            if (cell.isOcean && row < height * 0.15) {
                tileType = 'snow';
            }

            let baseTex = texturesRef.current[cell.isOcean && tileType !== 'snow' ? 'water' : tileType];
            
            // Add variance to snow
            if (tileType === 'snow') {
                const hash = Math.abs(col * 73856093 ^ row * 19349663) % 6;
                baseTex = texturesRef.current[`snow_${hash}`];
            }

            // Add variance to grass using a deterministic hash so it doesn't flicker on re-render
            if (tileType === 'grass' && !cell.isOcean) {
                // hash coordinates for a stable pseudo-random value between 0 and 11
                const hash = Math.abs(col * 73856093 ^ row * 19349663) % 12;
                baseTex = texturesRef.current[`grass_${hash}`];
            }
            
            if (baseTex) {
                // If it is grass, we draw a 100% SOLID base first (6,1) to prevent "black holes" 
                // because the variety tiles have subtle transparency
                if (tileType === 'grass' && !cell.isOcean) {
                    const base = new Sprite(texturesRef.current['grass_solid']);
                    base.position.set(x, y);
                    base.width = base.height = cellSize;
                    landContainer.addChild(base);
                }

                const s = new Sprite(baseTex);
                s.position.set(x, y);
                // Use perfect rounding for total seamlessness
                s.width = s.height = cellSize; 
                if (cell.isOcean) waterContainer.addChild(s);
                else {
                    s.zIndex = 0;
                    landContainer.addChild(s);
                }
            } else {
                // FALLBACK: Use grass to prevent black tile voids
                const fallback = texturesRef.current['grass'];
                if (fallback) {
                    const s = new Sprite(fallback);
                    s.position.set(x, y);
                    s.width = s.height = cellSize;
                    landContainer.addChild(s);
                }
            }

            // 2. Advanced Auto-Tiling (Fringe & Bitmasking)
            // We blend Grass over Sand/Desert/Water/Snow
            if (!cell.isOcean && tileType === 'grass') {
                const neighbors = [
                    { c: col, r: row - 1, key: 'edge_n' },
                    { c: col, r: row + 1, key: 'edge_s' },
                    { c: col + 1, r: row, key: 'edge_e' },
                    { c: col - 1, r: row, key: 'edge_w' }
                ];

                for (const n of neighbors) {
                    const nb = getCell(n.c, n.r);
                    if (nb) {
                        const targetType = getTileType(nb.biome);
                        if (targetType === 'desert' || nb.isOcean || targetType === 'snow') {
                            const edgeTex = texturesRef.current[n.key];
                            if (edgeTex) {
                                const es = new Sprite(edgeTex);
                                es.position.set(x, y);
                                es.width = es.height = cellSize;
                                
                                // Dynamic Snow Tinting
                                if (targetType === 'snow') {
                                    es.tint = 0xddedff; // Soft blue-ish white
                                }
                                
                                es.zIndex = 1;
                                landContainer.addChild(es);
                            }
                        }
                    }
                }
            }

            // 3. Place Props (Mountain/Forest/Desert/Snow)
            const propKey = getPropKey(cell.biome);
            if (propKey === 'mountain') {
                const isSnowy = cell.biome.toLowerCase().includes('snow');
                const tex = texturesRef.current[isSnowy ? 'snow_mountain' : 'mountain'];
                if (tex) {
                    const s = new Sprite(tex);
                    s.anchor.set(0.5, 0.85);
                    // More aggressive jitter for organic look
                    const jitterX = (Math.random() - 0.5) * (cellSize * 0.4);
                    const jitterY = (Math.random() - 0.5) * (cellSize * 0.25);
                    s.position.set(x + cellSize / 2 + jitterX, y + cellSize / 2 + jitterY);
                    s.width = s.height = cellSize * 2.2;
                    s.zIndex = 10 + row; 
                    propContainer.addChild(s);
                }
            } else if (propKey === 'snow_tree') {
                const tex = propsRef.current['snow_tree'];
                if (tex) {
                    const s = new Sprite(tex);
                    s.anchor.set(0.5, 0.85);
                    const jitterX = (Math.random() - 0.5) * (cellSize * 0.5);
                    const jitterY = (Math.random() - 0.5) * (cellSize * 0.3);
                    s.position.set(x + cellSize / 2 + jitterX, y + cellSize / 2 + jitterY);
                    s.width = s.height = cellSize * 2.2; // Huge snowy pines
                    s.zIndex = 20 + row;
                    propContainer.addChild(s);
                }
            } else if (propKey === 'desert_prop') {
                const isPalm = Math.random() > 0.65;
                const tex = propsRef.current[isPalm ? 'palm' : 'cactus'];
                if (tex) {
                    const s = new Sprite(tex);
                    s.anchor.set(0.5, 0.85);
                    const jitterX = (Math.random() - 0.5) * (cellSize * 0.6);
                    const jitterY = (Math.random() - 0.5) * (cellSize * 0.4);
                    s.position.set(x + cellSize / 2 + jitterX, y + cellSize / 2 + jitterY);
                    s.width = s.height = cellSize * (isPalm ? 2.0 : 1.3);
                    s.zIndex = 15 + row;
                    propContainer.addChild(s);
                }
            }

            // 4. Anchors
            if (cell.anchorName) {
                const g = new Graphics();
                g.circle(x + cellSize / 2, y + cellSize / 2, cellSize * 0.2);
                g.fill({ color: '#ffcc00', alpha: 1.0 });
                g.stroke({ color: '#000000', width: 1.5 });
                anchorContainer.addChild(g);
            }
        }

        // Final Atmosphere - tuned for pixel art
        const crt = new filters.CRTFilter({
            lineWidth: 0, // No scanlines for now, too distracting on small pixels
            vignetting: 0.2,
            vignettingAlpha: 0.3,
            noise: 0.02
        });
        grid.filters = [crt];

        world.addChildAt(grid, 0);

        const scale = Math.min(
            (canvasW * 0.9) / (width * cellSize),
            (canvasH * 0.9) / (height * cellSize),
        );
        world.scale.set(scale);
        world.x = (canvasW - width * cellSize * scale) / 2;
        world.y = (canvasH - height * cellSize * scale) / 2;
    }, [overworldMap, pixiReady]);

    useEffect(() => {
        if (!playerRef.current || !worldRef.current || mapDimsRef.current.w === 0) return;
        const cs = cellSizeRef.current;
        const player = playerRef.current;
        player.clear();
        player.circle(playerPosition.x * cs + cs / 2, playerPosition.y * cs + cs / 2, cs * 0.45);
        player.fill('#ffd700', 0.8);
        player.circle(playerPosition.x * cs + cs / 2, playerPosition.y * cs + cs / 2, cs * 0.45);
        player.stroke({ color: '#ffffff', width: 2 });
    }, [playerPosition]);

    useEffect(() => {
        if (!pixiReady || !worldRef.current) return;
        const world = worldRef.current;
        const cs = cellSizeRef.current;

        if (pinContainerRef.current) {
            world.removeChild(pinContainerRef.current);
            pinContainerRef.current.destroy({ children: true });
        }

        const pinContainer = new Container();
        pinContainer.zIndex = 9;
        world.addChild(pinContainer);
        pinContainerRef.current = pinContainer;

        for (const pin of pins) {
            const px = pin.x * cs + cs / 2;
            const py = pin.y * cs + cs / 2;
            const radius = Math.max(3, cs * 0.35);

            const g = new Graphics();
            g.circle(px, py, radius);
            g.fill({ color: pin.color ?? '#e05c5c', alpha: 0.9 });
            g.stroke({ color: '#ffffff', width: 1.5 });
            pinContainer.addChild(g);

            const label = new Text({
                text: pin.label,
                style: {
                    fontFamily: 'monospace',
                    fontSize: Math.max(8, cs * 1.1),
                    fill: '#ffffff',
                    stroke: { color: '#000000', width: 3 },
                    align: 'center',
                },
            });
            label.anchor.set(0.5, 1.0);
            label.position.set(px, py - radius - 2);
            pinContainer.addChild(label);
        }

        world.sortChildren();
    }, [pins, pixiReady]);

    return (
        <div className="w-full h-full relative">
            <div
                ref={containerRef}
                className="w-full h-full"
                style={{ cursor: isPinMode ? 'crosshair' : 'default' }}
            />

            {pendingPin !== null && (() => {
                const world = worldRef.current;
                const cs = cellSizeRef.current;
                let ox = 0, oy = 0;
                if (world && cs > 0) {
                    ox = pendingPin.x * cs * world.scale.x + world.x;
                    oy = pendingPin.y * cs * world.scale.y + world.y;
                }
                return (
                    <div
                        className="absolute z-50 bg-surface border border-terminal/50 px-3 py-2 shadow-lg"
                        style={{ left: ox + 8, top: oy + 8 }}
                    >
                        <p className="text-[9px] uppercase tracking-widest text-text-dim mb-1">Pin Label</p>
                        <input
                            autoFocus
                            maxLength={40}
                            value={pinLabelDraft}
                            onChange={e => setPinLabelDraft(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && pinLabelDraft.trim()) {
                                    addPin(activeCampaignId!, {
                                        id: crypto.randomUUID(),
                                        x: pendingPin.x,
                                        y: pendingPin.y,
                                        label: pinLabelDraft.trim(),
                                        color: '#e05c5c',
                                        createdAt: Date.now(),
                                    });
                                    setPinLabelDraft('');
                                } else if (e.key === 'Escape') {
                                    setPendingPin(null);
                                }
                            }}
                            className="bg-void border border-border text-terminal text-[11px] font-mono px-2 py-1 outline-none w-36"
                            placeholder="Enter name…"
                        />
                        <div className="flex gap-2 mt-1">
                            <button
                                onClick={() => {
                                    if (!pinLabelDraft.trim()) return;
                                    addPin(activeCampaignId!, {
                                        id: crypto.randomUUID(),
                                        x: pendingPin.x,
                                        y: pendingPin.y,
                                        label: pinLabelDraft.trim(),
                                        color: '#e05c5c',
                                        createdAt: Date.now(),
                                    });
                                    setPinLabelDraft('');
                                }}
                                className="text-[9px] uppercase tracking-widest text-terminal hover:text-terminal/70"
                            >Place</button>
                            <button
                                onClick={() => setPendingPin(null)}
                                className="text-[9px] uppercase tracking-widest text-text-dim hover:text-danger"
                            >Cancel</button>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}