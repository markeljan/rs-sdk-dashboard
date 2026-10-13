// The client's frame counter, split out of Client so dash3d modules can read it
// without importing the whole game client (the standalone viewer bundles
// ClientPlayer for character sprites and must not drag Client in with it).
export default class LoopCycle {
    static value: number = 0;
}
