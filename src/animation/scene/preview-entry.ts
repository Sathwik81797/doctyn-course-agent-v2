// Entry of the dashboard preview bundle (public/scene.js): exposes the frame renderer as window.DoctynScene.
import { renderFrame } from "./core.js";

(globalThis as unknown as { DoctynScene: { renderFrame: typeof renderFrame } }).DoctynScene = { renderFrame };
