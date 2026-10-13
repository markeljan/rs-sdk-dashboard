/* tslint:disable */
/* eslint-disable */
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {number} masks
 * @returns {boolean}
 */
export function isFlagged(x: number, z: number, y: number, masks: number): boolean;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} extraFlag
 * @returns {boolean}
 */
export function hasLineOfSight(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcWidth: number, srcHeight: number, destWidth: number, destHeight: number, extraFlag: number): boolean;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {number} size
 * @param {boolean} add
 */
export function changePlayer(x: number, z: number, y: number, size: number, add: boolean): void;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcSize
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} angle
 * @param {number} shape
 * @param {boolean} moveNear
 * @param {number} blockAccessFlags
 * @param {number} maxWaypoints
 * @param {CollisionType} collision
 * @returns {Uint32Array}
 */
export function findPath(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcSize: number, destWidth: number, destHeight: number, angle: number, shape: number, moveNear: boolean, blockAccessFlags: number, maxWaypoints: number, collision: CollisionType): Uint32Array;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {boolean} add
 */
export function changeFloor(x: number, z: number, y: number, add: boolean): void;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {number} width
 * @param {number} length
 * @param {boolean} blockrange
 * @param {boolean} breakroutefinding
 * @param {boolean} add
 */
export function changeLoc(x: number, z: number, y: number, width: number, length: number, blockrange: boolean, breakroutefinding: boolean, add: boolean): void;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} extraFlag
 * @returns {boolean}
 */
export function hasLineOfWalk(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcWidth: number, srcHeight: number, destWidth: number, destHeight: number, extraFlag: number): boolean;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {boolean} add
 */
export function changeRoof(x: number, z: number, y: number, add: boolean): void;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 */
export function allocateIfAbsent(x: number, z: number, y: number): void;
/**
 * @param {LocShape} shape
 * @returns {LocLayer}
 */
export function locShapeLayer(shape: LocShape): LocLayer;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @returns {boolean}
 */
export function isZoneAllocated(x: number, z: number, y: number): boolean;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} extraFlag
 * @returns {Uint32Array}
 */
export function lineOfWalk(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcWidth: number, srcHeight: number, destWidth: number, destHeight: number, extraFlag: number): Uint32Array;
/**
 * @param {number} y
 * @param {number} x
 * @param {number} z
 * @param {number} offsetX
 * @param {number} offsetZ
 * @param {number} size
 * @param {number} extraFlag
 * @param {CollisionType} collision
 * @returns {boolean}
 */
export function canTravel(y: number, x: number, z: number, offsetX: number, offsetZ: number, size: number, extraFlag: number, collision: CollisionType): boolean;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 */
export function deallocateIfPresent(x: number, z: number, y: number): void;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {number} mask
 */
export function __set(x: number, z: number, y: number, mask: number): void;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {number} size
 * @param {boolean} add
 */
export function changeNpc(x: number, z: number, y: number, size: number, add: boolean): void;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} extraFlag
 * @param {CollisionType} collision
 * @returns {Uint32Array}
 */
export function findNaivePath(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcWidth: number, srcHeight: number, destWidth: number, destHeight: number, extraFlag: number, collision: CollisionType): Uint32Array;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} srcSize
 * @param {number} angle
 * @param {number} shape
 * @param {number} blockAccessFlags
 * @returns {boolean}
 */
export function reached(y: number, srcX: number, srcZ: number, destX: number, destZ: number, destWidth: number, destHeight: number, srcSize: number, angle: number, shape: number, blockAccessFlags: number): boolean;
/**
 * @param {number} x
 * @param {number} z
 * @param {number} y
 * @param {number} angle
 * @param {number} shape
 * @param {boolean} blockrange
 * @param {boolean} breakroutefinding
 * @param {boolean} add
 */
export function changeWall(x: number, z: number, y: number, angle: number, shape: number, blockrange: boolean, breakroutefinding: boolean, add: boolean): void;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcSize
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} angle
 * @param {number} shape
 * @param {boolean} moveNear
 * @param {number} blockAccessFlags
 * @param {number} maxWaypoints
 * @param {CollisionType} collision
 * @returns {Uint32Array}
 */
export function findLongPath(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcSize: number, destWidth: number, destHeight: number, angle: number, shape: number, moveNear: boolean, blockAccessFlags: number, maxWaypoints: number, collision: CollisionType): Uint32Array;
/**
 * @param {number} y
 * @param {number} srcX
 * @param {number} srcZ
 * @param {number} destX
 * @param {number} destZ
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} extraFlag
 * @returns {Uint32Array}
 */
export function lineOfSight(y: number, srcX: number, srcZ: number, destX: number, destZ: number, srcWidth: number, srcHeight: number, destWidth: number, destHeight: number, extraFlag: number): Uint32Array;
export enum BlockAccessFlag {
  BLOCK_NORTH = 1,
  BLOCK_EAST = 2,
  BLOCK_SOUTH = 4,
  BLOCK_WEST = 8,
}
export enum CollisionFlag {
  OPEN = 0,
  WALL_NORTH_WEST = 1,
  WALL_NORTH = 2,
  WALL_NORTH_EAST = 4,
  WALL_EAST = 8,
  WALL_SOUTH_EAST = 16,
  WALL_SOUTH = 32,
  WALL_SOUTH_WEST = 64,
  WALL_WEST = 128,
  LOC = 256,
  WALL_NORTH_WEST_PROJ_BLOCKER = 512,
  WALL_NORTH_PROJ_BLOCKER = 1024,
  WALL_NORTH_EAST_PROJ_BLOCKER = 2048,
  WALL_EAST_PROJ_BLOCKER = 4096,
  WALL_SOUTH_EAST_PROJ_BLOCKER = 8192,
  WALL_SOUTH_PROJ_BLOCKER = 16384,
  WALL_SOUTH_WEST_PROJ_BLOCKER = 32768,
  WALL_WEST_PROJ_BLOCKER = 65536,
  LOC_PROJ_BLOCKER = 131072,
  FLOOR_DECORATION = 262144,
  /**
   *
   *     * Custom flag dedicated to blocking NPCs.
   *     * It should be noted that this is a custom flag, and you do not need to use this.
   *     * The pathfinder takes the flag as a custom option, so you may use any other flag, this just defines
   *     * a reliable constant to use
   *     
   */
  NPC = 524288,
  /**
   *
   *     * Custom flag dedicated to blocking players, projectiles as well as NPCs.
   *     * An example of a monster to set this flag is Brawler. Note that it is unclear if this flag
   *     * prevents NPCs, as there is a separate flag option for it.
   *     * This flag is similar to the one above, except it's strictly for NPCs.
   *     
   */
  PLAYER = 1048576,
  FLOOR = 2097152,
  WALL_NORTH_WEST_ROUTE_BLOCKER = 4194304,
  WALL_NORTH_ROUTE_BLOCKER = 8388608,
  WALL_NORTH_EAST_ROUTE_BLOCKER = 16777216,
  WALL_EAST_ROUTE_BLOCKER = 33554432,
  WALL_SOUTH_EAST_ROUTE_BLOCKER = 67108864,
  WALL_SOUTH_ROUTE_BLOCKER = 134217728,
  WALL_SOUTH_WEST_ROUTE_BLOCKER = 268435456,
  WALL_WEST_ROUTE_BLOCKER = 536870912,
  LOC_ROUTE_BLOCKER = 1073741824,
  /**
   *
   *     * Roof flag, used to bind NPCs to not leave the buildings they spawn in. This is a custom flag.
   *     
   */
  ROOF = 2147483648,
  FLOOR_BLOCKED = 2359296,
  WALK_BLOCKED = 2359552,
  BLOCK_WEST = 2359560,
  BLOCK_EAST = 2359680,
  BLOCK_SOUTH = 2359554,
  BLOCK_NORTH = 2359584,
  BLOCK_SOUTH_WEST = 2359566,
  BLOCK_SOUTH_EAST = 2359683,
  BLOCK_NORTH_WEST = 2359608,
  BLOCK_NORTH_EAST = 2359776,
  BLOCK_NORTH_AND_SOUTH_EAST = 2359614,
  BLOCK_NORTH_AND_SOUTH_WEST = 2359779,
  BLOCK_NORTH_EAST_AND_WEST = 2359695,
  BLOCK_SOUTH_EAST_AND_WEST = 2359800,
  BLOCK_WEST_ROUTE_BLOCKER = 36044800,
  BLOCK_EAST_ROUTE_BLOCKER = 539361280,
  BLOCK_SOUTH_ROUTE_BLOCKER = 277318006,
  BLOCK_NORTH_ROUTE_BLOCKER = 136708096,
  BLOCK_SOUTH_WEST_ROUTE_BLOCKER = 1134821376,
  BLOCK_SOUTH_EAST_ROUTE_BLOCKER = 1625554944,
  BLOCK_NORTH_WEST_ROUTE_BLOCKER = 1310982144,
  BLOCK_NORTH_EAST_ROUTE_BLOCKER = 2015625216,
  BLOCK_NORTH_AND_SOUTH_EAST_ROUTE_BLOCKER = 1336147968,
  BLOCK_NORTH_AND_SOUTH_WEST_ROUTE_BLOCKER = 2028208128,
  BLOCK_NORTH_EAST_AND_WEST_ROUTE_BLOCKER = 1675886592,
  BLOCK_SOUTH_EAST_AND_WEST_ROUTE_BLOCKER = 2116288512,
  NULL = 2147483647,
}
export enum CollisionType {
  NORMAL = 0,
  BLOCKED = 1,
  INDOORS = 2,
  OUTDOORS = 3,
  LINE_OF_SIGHT = 4,
}
export enum LocAngle {
  WEST = 0,
  NORTH = 1,
  EAST = 2,
  SOUTH = 3,
}
export enum LocLayer {
  WALL = 0,
  WALL_DECOR = 1,
  GROUND = 2,
  GROUND_DECOR = 3,
}
export enum LocShape {
  WALL_STRAIGHT = 0,
  WALL_DIAGONAL_CORNER = 1,
  WALL_L = 2,
  WALL_SQUARE_CORNER = 3,
  WALLDECOR_STRAIGHT_NOOFFSET = 4,
  WALLDECOR_STRAIGHT_OFFSET = 5,
  WALLDECOR_DIAGONAL_OFFSET = 6,
  WALLDECOR_DIAGONAL_NOOFFSET = 7,
  WALLDECOR_DIAGONAL_BOTH = 8,
  WALL_DIAGONAL = 9,
  CENTREPIECE_STRAIGHT = 10,
  CENTREPIECE_DIAGONAL = 11,
  ROOF_STRAIGHT = 12,
  ROOF_DIAGONAL_WITH_ROOFEDGE = 13,
  ROOF_DIAGONAL = 14,
  ROOF_L_CONCAVE = 15,
  ROOF_L_CONVEX = 16,
  ROOF_FLAT = 17,
  ROOFEDGE_STRAIGHT = 18,
  ROOFEDGE_DIAGONAL_CORNER = 19,
  ROOFEDGE_L = 20,
  ROOFEDGE_SQUARE_CORNER = 21,
  GROUND_DECOR = 22,
}
