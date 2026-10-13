// Local pathfinding using bundled collision data
import * as rsmod from '../server/vendor/rsmod-pathfinder';
import { CollisionType, CollisionFlag } from '../server/vendor/rsmod-pathfinder';
import collisionData from './collision-data.json';

let initialized = false;

interface CollisionData {
    tiles: Array<[number, number, number, number]>;
    zones: Array<[number, number, number]>;
    doors?: Array<[number, number, number, number, number, number]>; // [level, x, z, shape, angle, blockrange]
}

export interface DoorInfo {
    level: number;
    x: number;
    z: number;
    shape: number;
    angle: number;
    blockrange: boolean;
    /**
     * What kind of passable obstacle this is. Absent (or 'door') for the
     * wall-shaped doors/gates exported in collision-data.json; 'stile' for the
     * centrepiece "Climb-over" stiles indexed by STILES below. Crossing a stile
     * is a loc op that moves the player over it, not an open/close toggle.
     */
    kind?: 'door' | 'stile';
    /** Tiles a centrepiece obstacle occupies (stiles only). */
    tiles?: Array<{ x: number; z: number }>;
}

/** A passable obstacle crossed by one step of a planned route, in route order. */
export interface RouteObstacle {
    obstacle: DoorInfo;
    /** Last route tile before the obstacle (the side to approach it from). */
    from: CollisionPoint;
    /** First route tile past (or on) the obstacle. */
    to: CollisionPoint;
    /** Index of `from` in the rasterized route (0 = route start). */
    stepIndex: number;
}

/**
 * Static stiles (centrepiece locs whose only op is "Climb-over"). They block
 * movement like any loc, so without this index the offline planner routes
 * the long way around every field fence (or fails). Derived from
 * server/content/maps/*.jm2: loc 993 `fullstyle` (no requirement, op1
 * Climb-over, skill_agility/scripts/shortcuts.rs2) and 3730 `death_fullstyle`
 * (Death Plateau). Each is length=2 across the fence: angle 0/2 occupies
 * (x, z..z+1) and is crossed north-south, angle 1/3 occupies (x..x+1, z) and is
 * crossed east-west. [level, x, z, angle]
 */
const STILES: Array<[number, number, number, number]> = [
    [0, 2638, 3350, 1], // Ardougne north farm
    [0, 2647, 3375, 1], // Ardougne north farm
    [0, 2761, 3436, 2], // Seers' Village / Camelot field
    [0, 2817, 3562, 0], // Death Plateau (death_fullstyle)
    [0, 3043, 3305, 3], // Falador south farm
    [0, 3063, 3282, 0], // Falador south-east farm
    [0, 3197, 3276, 0], // Lumbridge, Fred the Farmer's field
];

/** Option texts that pass a door/gate/stile on a planned route. */
export const OBSTACLE_PASS_OPTION = /^(open|climb-over)$/i;

/**
 * How long evidence that a door is locked ("The door is locked", "You need a
 * key", a guard dialog instead of an open) keeps it out of route planning.
 * Long enough that a grinding bot stops re-trying the same Ardougne house
 * door every 30 seconds; short enough that a door a quest later unlocks is
 * retried in the same session.
 */
export const LOCKED_DOOR_TTL_MS = 10 * 60_000;
/** TTL for a door that repeatedly could not be reached or did not open. */
export const STUCK_DOOR_TTL_MS = 60_000;

export interface CollisionPoint {
    level: number;
    x: number;
    z: number;
}

interface TemporaryDoorBlock {
    door: DoorInfo;
    expiresAt: number;
}

/**
 * Session-owned evidence that a door is temporarily impassable.
 *
 * Entries expire automatically so a transient route failure cannot poison the
 * process-wide collision map for every bot until restart.
 */
export class TemporaryDoorBlocklist {
    private entries = new Map<string, TemporaryDoorBlock>();

    constructor(private readonly now: () => number = Date.now) {}

    block(door: DoorInfo, ttlMs: number = 30_000): void {
        this.entries.set(doorKey(door.level, door.x, door.z), {
            door,
            expiresAt: this.now() + Math.max(0, ttlMs)
        });
    }

    active(): DoorInfo[] {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key);
        }
        return [...this.entries.values()].map(entry => entry.door);
    }

    has(level: number, x: number, z: number): boolean {
        this.active();
        return this.entries.has(doorKey(level, x, z));
    }

    clear(): void {
        this.entries.clear();
    }
}

// Spatial index of all known door positions, keyed by "level,x,z"
const doorIndex = new Map<string, DoorInfo>();
// Stiles keyed by EVERY footprint tile ("level,x,z" -> the stile, origin x/z).
const stileIndex = new Map<string, DoorInfo>();

// Zones that have at least one collision tile — zones with zero collision data
// are likely open ocean/void and should not be treated as walkable land.
const populatedZones = new Set<string>();

// One-way doors that should NOT be unmasked in the door index.
// These doors can only be opened from one side; routing through them traps the bot.
const ONE_WAY_DOORS = new Set<string>([
    '0,3108,3353', // Draynor Manor front door (west tile) — only opens from outside
    '0,3109,3353', // Draynor Manor front door (east tile) — only opens from outside
    '0,2924,9654', // Melzar's Maze basement 'funexit' door — only opens from the maze side
    '0,2927,9649', // Melzar's Maze basement 'funexit' door — only opens from the maze side
    '0,2931,9640', // Melzar's Maze basement 'funexit' door — only opens from the maze side
]);

function doorKey(level: number, x: number, z: number): string {
    return `${level},${x},${z}`;
}

export function initPathfinding(): void {
    if (initialized) return;

    const data = collisionData as CollisionData;
    const start = Date.now();

    // Allocate all zones first (includes walkable areas with no collision tiles)
    for (const [level, zoneX, zoneZ] of data.zones) {
        rsmod.allocateIfAbsent(zoneX, zoneZ, level);
    }

    // Allocate mainland zones so the 2048x2048 BFS grid can traverse
    // open land between cities. Unallocated zones return NULL (blocked),
    // so without this the pathfinder can't cross gaps in the collision data.
    // Newly-allocated zones default to OPEN (walkable), which is correct
    // for grassland/roads. Zones already allocated above keep their flags.
    let mainlandZones = 0;
    for (let x = 2304; x <= 3392; x += 8) {
        for (let z = 2944; z <= 3584; z += 8) {
            if (!rsmod.isZoneAllocated(x, z, 0)) {
                rsmod.allocateIfAbsent(x, z, 0);
                mainlandZones++;
            }
        }
    }

    // Set collision flags for tiles that have them (includes wall flags)
    for (const [level, x, z, flags] of data.tiles) {
        rsmod.__set(x, z, level, flags);
        // Track which zones have at least one collision tile (likely land, not ocean)
        populatedZones.add(`${level},${x & ~7},${z & ~7}`);
    }

    // Remove wall collision at door/gate positions so the pathfinder
    // routes through doorways while still respecting permanent walls.
    // Uses rsmod.changeWall(add=false) — the same method the server uses
    // when doors are opened at runtime.
    let doorCount = 0;
    let skippedOneWay = 0;
    if (data.doors) {
        for (const [level, x, z, shape, angle, blockrange] of data.doors) {
            const key = doorKey(level, x, z);

            // Skip one-way doors — keep their wall collision so the pathfinder
            // won't route through them (entering traps the bot).
            if (ONE_WAY_DOORS.has(key)) {
                skippedOneWay++;
                continue;
            }

            rsmod.changeWall(x, z, level, angle, shape, !!blockrange, false, false);
            doorIndex.set(key, {
                level, x, z, shape, angle, blockrange: !!blockrange
            });
            doorCount++;
        }
    }

    // Stiles: clear the LOC flag on their footprint so routes cross fields
    // the way players do. BotActions climbs over each stile a route crosses.
    for (const [level, x, z, angle] of STILES) {
        const tiles = stileFootprint(x, z, angle);
        const stile: DoorInfo = { level, x, z, shape: 10, angle, blockrange: false, kind: 'stile', tiles };
        for (const tile of tiles) {
            rsmod.__set(tile.x, tile.z, level, (collisionFlagsAt(level, tile.x, tile.z) & ~CollisionFlag.LOC) >>> 0);
            stileIndex.set(doorKey(level, tile.x, tile.z), stile);
        }
    }

    initialized = true;
    console.log(`Pathfinding initialized in ${Date.now() - start}ms (${data.zones.length} zones + ${mainlandZones} mainland fill, ${data.tiles.length} tiles, ${doorCount} doors masked, ${skippedOneWay} one-way doors blocked, ${STILES.length} stiles)`);
}

// Check if a zone has collision data
export function isZoneAllocated(level: number, x: number, z: number): boolean {
    if (!initialized) {
        initPathfinding();
    }
    return rsmod.isZoneAllocated(x, z, level);
}

// Find long-distance path (2048x2048 search grid, ±1024 tile reach)
export function findLongPath(
    level: number,
    srcX: number,
    srcZ: number,
    destX: number,
    destZ: number,
    maxWaypoints: number = 500,
    blockedDoors: Iterable<DoorInfo> = []
): Array<{ x: number; z: number; level: number }> {
    if (!initialized) {
        initPathfinding();
    }

    // Re-apply only this SDK session's temporary door walls for the duration of
    // this synchronous query. The shared collision snapshot is restored before
    // another bot can pathfind.
    const applied: DoorInfo[] = [];
    const stileTiles: Array<{ level: number; x: number; z: number; flags: number }> = [];
    try {
        for (const door of blockedDoors) {
            if (door.kind === 'stile') {
                for (const tile of door.tiles ?? stileFootprint(door.x, door.z, door.angle)) {
                    const flags = collisionFlagsAt(door.level, tile.x, tile.z);
                    stileTiles.push({ level: door.level, x: tile.x, z: tile.z, flags });
                    rsmod.__set(tile.x, tile.z, door.level, (flags | CollisionFlag.LOC) >>> 0);
                }
                continue;
            }
            rsmod.changeWall(
                door.x, door.z, door.level,
                door.angle, door.shape, door.blockrange,
                false, true
            );
            applied.push(door);
        }

        const waypointsRaw = rsmod.findLongPath(
            level, srcX, srcZ, destX, destZ,
            1, 1, 1, 0, -1, true, 0, maxWaypoints, CollisionType.NORMAL
        );

        return unpackWaypoints(waypointsRaw);
    } finally {
        for (const door of applied) {
            rsmod.changeWall(
                door.x, door.z, door.level,
                door.angle, door.shape, door.blockrange,
                false, false
            );
        }
        for (let i = stileTiles.length - 1; i >= 0; i--) {
            const tile = stileTiles[i]!;
            rsmod.__set(tile.x, tile.z, tile.level, tile.flags);
        }
    }
}

function stileFootprint(x: number, z: number, angle: number): Array<{ x: number; z: number }> {
    // length=2, width=1; angles 1/3 rotate the footprint onto the x axis.
    return angle === 1 || angle === 3
        ? [{ x, z }, { x: x + 1, z }]
        : [{ x, z }, { x, z: z + 1 }];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Check if a tile is walkable (no blocking flags). */
export function isTileWalkable(level: number, x: number, z: number): boolean {
    if (!initialized) initPathfinding();
    return !rsmod.isFlagged(x, z, level, CollisionFlag.WALK_BLOCKED);
}

/** Check if a tile has specific collision flags set. */
export function isFlagged(x: number, z: number, level: number, masks: number): boolean {
    if (!initialized) initPathfinding();
    return rsmod.isFlagged(x, z, level, masks);
}

/**
 * Check if the zone containing (x, z) has any collision tiles.
 * Zones with zero collision data are likely open ocean/void — real walkable
 * land always has some collision data (objects, walls, floor flags nearby).
 */
export function isZoneLikelyLand(level: number, x: number, z: number): boolean {
    return populatedZones.has(`${level},${x & ~7},${z & ~7}`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  DOOR PATH ANALYSIS — identify doors a computed path crosses through
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Given a list of waypoints, return the doors the path passes through or
 * steps adjacent to (wall collision is directional so the path may step
 * beside a door tile rather than onto it).  Results are in path order.
 */
export function findDoorsAlongPath(
    waypoints: Array<{ x: number; z: number; level: number }>
): DoorInfo[] {
    if (!initialized) initPathfinding();
    const doors: DoorInfo[] = [];
    const seen = new Set<string>();

    const inspect = (wp: { x: number; z: number; level: number }) => {
        // Check the waypoint tile and its 4 cardinal neighbours
        const candidates = [
            doorKey(wp.level, wp.x, wp.z),
            doorKey(wp.level, wp.x, wp.z + 1),
            doorKey(wp.level, wp.x, wp.z - 1),
            doorKey(wp.level, wp.x + 1, wp.z),
            doorKey(wp.level, wp.x - 1, wp.z),
        ];
        for (const key of candidates) {
            if (!seen.has(key) && doorIndex.has(key)) {
                seen.add(key);
                doors.push(doorIndex.get(key)!);
            }
        }
    };

    for (let i = 0; i < waypoints.length; i++) {
        const from = waypoints[i]!;
        inspect(from);
        const to = waypoints[i + 1];
        if (!to || to.level !== from.level) continue;

        // rsmod compresses straight runs into endpoint waypoints. Rasterize
        // every tile on each leg so a door halfway down a long horizontal,
        // vertical or diagonal run is not invisible to the caller.
        let x = from.x;
        let z = from.z;
        const dx = Math.abs(to.x - x);
        const dz = Math.abs(to.z - z);
        const sx = x < to.x ? 1 : -1;
        const sz = z < to.z ? 1 : -1;
        let error = dx - dz;
        while (x !== to.x || z !== to.z) {
            const twice = error * 2;
            if (twice > -dz) { error -= dz; x += sx; }
            if (twice < dx) { error += dx; z += sz; }
            inspect({ x, z, level: from.level });
        }
    }

    return doors;
}

/** Look up a door at an exact position. */
export function getDoorAt(level: number, x: number, z: number): DoorInfo | undefined {
    if (!initialized) initPathfinding();
    return doorIndex.get(doorKey(level, x, z));
}

/**
 * Look up a passable obstacle at a tile: an indexed door/gate at its loc
 * tile, or a stile on any tile of its footprint (returned with its origin).
 */
export function getObstacleAt(level: number, x: number, z: number): DoorInfo | undefined {
    if (!initialized) initPathfinding();
    const key = doorKey(level, x, z);
    return doorIndex.get(key) ?? stileIndex.get(key);
}

/** Every indexed stile (origin tile + footprint). */
export function getStiles(): DoorInfo[] {
    if (!initialized) initPathfinding();
    return [...new Set(stileIndex.values())];
}

/** Expand compressed route waypoints into the unit steps a player walks. */
export function rasterizeRoute(
    waypoints: ReadonlyArray<{ x: number; z: number; level: number }>
): CollisionPoint[] {
    const tiles: CollisionPoint[] = [];
    for (let i = 0; i < waypoints.length; i++) {
        const from = waypoints[i]!;
        const last = tiles[tiles.length - 1];
        if (!last || last.x !== from.x || last.z !== from.z || last.level !== from.level)
            tiles.push({ x: from.x, z: from.z, level: from.level });
        const to = waypoints[i + 1];
        if (!to || to.level !== from.level) continue;
        let x = from.x;
        let z = from.z;
        // rsmod turn points are joined by straight cardinal/diagonal runs;
        // step diagonally first, then straight, which is how those runs walk.
        while (x !== to.x || z !== to.z) {
            x += Math.sign(to.x - x);
            z += Math.sign(to.z - z);
            tiles.push({ x, z, level: from.level });
        }
    }
    return tiles;
}

/** Stiles a route steps onto, in route order (cheap: no door causality checks). */
export function findStilesAlongPath(
    waypoints: ReadonlyArray<{ x: number; z: number; level: number }>
): DoorInfo[] {
    if (!initialized) initPathfinding();
    if (stileIndex.size === 0) return [];
    const stiles: DoorInfo[] = [];
    let previous: DoorInfo | undefined;
    for (const tile of rasterizeRoute(waypoints)) {
        const stile = stileIndex.get(doorKey(tile.level, tile.x, tile.z));
        if (stile && stile !== previous && !stiles.includes(stile)) stiles.push(stile);
        previous = stile;
    }
    return stiles;
}

/**
 * The passable obstacles (doors, gates, stiles) a route actually crosses, in
 * route order. Unlike findDoorsAlongPath (a proximity heuristic that also
 * reports doors the route merely walks past), a door is reported only when
 * restoring its wall would block a step of the route - see doorBlocksStep -
 * and a stile only when a step lands on its footprint. Each hit carries the
 * tile to approach it from.
 *
 * Pass the player's own tile first: rsmod's waypoint list starts at the end
 * of the first run, not at the source tile.
 */
export function findObstaclesAlongPath(
    waypoints: ReadonlyArray<{ x: number; z: number; level: number }>
): RouteObstacle[] {
    if (!initialized) initPathfinding();
    const tiles = rasterizeRoute(waypoints);
    const hits: RouteObstacle[] = [];
    const seen = new Set<string>();
    const record = (obstacle: DoorInfo, from: CollisionPoint, to: CollisionPoint, stepIndex: number) => {
        const key = doorKey(obstacle.level, obstacle.x, obstacle.z);
        if (seen.has(key)) return;
        seen.add(key);
        hits.push({ obstacle, from, to, stepIndex });
    };

    for (let i = 0; i + 1 < tiles.length; i++) {
        const a = tiles[i]!;
        const b = tiles[i + 1]!;
        if (a.level !== b.level || Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) !== 1) continue;

        const stileB = stileIndex.get(doorKey(b.level, b.x, b.z));
        const stileA = stileIndex.get(doorKey(a.level, a.x, a.z));
        if (stileB && stileB !== stileA) record(stileB, a, b, i);

        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const traversable = rsmod.canTravel(a.level, a.x, a.z, dx, dz, 1, 0, CollisionType.NORMAL);
        const candidates = [a, b];
        if (dx !== 0 && dz !== 0) candidates.push({ x: a.x, z: b.z, level: a.level }, { x: b.x, z: a.z, level: a.level });
        for (const tile of candidates) {
            const door = doorIndex.get(doorKey(tile.level, tile.x, tile.z));
            if (!door || seen.has(doorKey(door.level, door.x, door.z))) continue;
            // A step the masked map itself rejects (a caller-mutated floor,
            // a stale route) cannot be attributed exactly; fall back to the
            // door sitting on one of the step's own tiles.
            const blocks = traversable
                ? doorBlocksStep(door, a, b)
                : (tile === a || tile === b);
            if (blocks) record(door, a, b, i);
        }
    }
    return hits;
}

function collisionFlagsAt(level: number, x: number, z: number): number {
    let flags = 0;
    for (let shift = 0; shift < 32; shift++) {
        const bit = 2 ** shift;
        if (rsmod.isFlagged(x, z, level, bit)) flags = (flags | bit) >>> 0;
    }
    return flags;
}

/**
 * Run one synchronous boolean query with a statically indexed door restored.
 * changeWall is not reference-counted, so removing the temporary wall could
 * erase an overlapping permanent flag. Snapshot and restore the complete 3x3
 * neighbourhood instead; every supported wall shape changes only its own tile
 * and an immediate neighbour.
 */
export function queryWithClosedDoor(door: DoorInfo, query: () => boolean): boolean {
    if (!initialized) initPathfinding();
    const snapshot: Array<{ x: number; z: number; flags: number }> = [];
    for (let x = door.x - 1; x <= door.x + 1; x++) {
        for (let z = door.z - 1; z <= door.z + 1; z++) {
            snapshot.push({ x, z, flags: collisionFlagsAt(door.level, x, z) });
        }
    }
    try {
        rsmod.changeWall(
            door.x, door.z, door.level,
            door.angle, door.shape, door.blockrange,
            false, true
        );
        return query();
    } finally {
        for (const tile of snapshot)
            rsmod.__set(tile.x, tile.z, door.level, tile.flags);
    }
}

/**
 * Test whether restoring one statically-known closed door would make an
 * otherwise traversable unit step fail. Door collision is removed from the
 * shared pathfinding snapshot during initialization, so this query restores
 * only the requested wall for the duration of two synchronous canTravel
 * calls. The try/finally is essential: callers must never observe a mutated
 * process-wide collision map.
 */
export function doorBlocksStep(door: DoorInfo, from: CollisionPoint, to: CollisionPoint): boolean {
    if (!initialized) initPathfinding();
    if (from.level !== to.level || from.level !== door.level) return false;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if ((dx === 0 && dz === 0) || Math.abs(dx) > 1 || Math.abs(dz) > 1) return false;

    // A door cannot be the cause when permanent collision already rejects the
    // step with all indexed doors in their normal unmasked state.
    const traversable = rsmod.canTravel(
        from.level, from.x, from.z, dx, dz,
        1, 0, CollisionType.NORMAL
    );
    if (!traversable) return false;

    return queryWithClosedDoor(door, () =>
        !rsmod.canTravel(
            from.level, from.x, from.z, dx, dz,
            1, 0, CollisionType.NORMAL
        )
    );
}

// Unpack waypoints from rsmod format
function unpackWaypoints(waypointsRaw: Uint32Array): Array<{ x: number; z: number; level: number }> {
    const waypoints: Array<{ x: number; z: number; level: number }> = [];
    for (let i = 0; i < waypointsRaw.length; i++) {
        const packed = waypointsRaw[i]!;
        waypoints.push({
            z: packed & 0x3FFF,
            x: (packed >> 14) & 0x3FFF,
            level: (packed >> 28) & 0x3
        });
    }
    return waypoints;
}
